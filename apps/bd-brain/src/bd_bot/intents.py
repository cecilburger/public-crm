"""Intent classification for inbound brand replies.

Rules first (fast, free, deterministic), with an optional Claude fallback for
anything the rules can't place. FLOWCHART.md §5.2 defines the eight intents;
UNKNOWN and OPT_OUT are added here to fill gaps §6.2 and §6.3.

The rules are tuned for how Indonesian brand contacts actually type on
WhatsApp — lowercase, abbreviated, no punctuation ("blm tertarik ka", "brp
harganya", "nanti aja dulu ya").
"""

from __future__ import annotations

import logging
import re
import unicodedata

from .config import Settings
from .models import Intent

log = logging.getLogger(__name__)


#: Things whose punctuation *is* their meaning, canonicalised to a word before
#: the punctuation strip below destroys them.
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_URL_RE = re.compile(
    r"\b(?:https?://|www\.)\S+|\b[\w-]+\.(?:com|co\.id|id|net|org|biz|link|shop)\b/?\S*",
    re.IGNORECASE,
)
_PERCENT_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*%")


def _normalise(text: str) -> str:
    """Lowercase, strip accents/emoji, collapse whitespace and elongations.

    Emails, URLs and percentages are turned into the words `email`, `link` and
    `N persen` first. The strip that follows removes every non-alphanumeric
    character, which silently destroyed all three: "12%" became "12", and a
    bare address became word soup ("ceo brandku co id"). Both carry real
    meaning here — a brand answering "what number did you have in mind?" with
    "12%", or handing over an address for the calendar invite — and neither
    was reachable by any rule. Canonicalising also makes the chat-export
    replay honest, since the corpus stores those spans pre-redacted as
    "[email]" and "[link]".
    """
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = _EMAIL_RE.sub(" email ", text)
    text = _URL_RE.sub(" link ", text)
    text = _PERCENT_RE.sub(r" \1 persen ", text)
    # A bare "%" with no figure — "Kak, %unt affiliator gimana?" — is the
    # commission question asked in shorthand. Stripped, it left "unt
    # affiliator gimana" and the system answer (24 Sep 2026).
    text = text.replace("%", " persen ")
    # The corpus ships these spans already redacted; land on the same tokens.
    text = re.sub(r"\[(email|link|phone)\]", r" \1 ", text)
    text = re.sub(r"[^a-z0-9\s?]", " ", text)
    # Letters only. Applied to every character it also ate digits:
    # "2000 affiliate" became "20 affiliate" and "15000000" became "150",
    # so any volume or budget with a repeated digit was silently rewritten.
    text = re.sub(r"([a-z])\1{2,}", r"\1", text)  # "okeee" -> "oke"
    return re.sub(r"\s+", " ", text).strip()


#: The three answers to "awareness, penjualan, atau keduanya?", as brands
#: write them. Grouped so `focus_of` can say which one came back.
_FOCUS_SALES = (
    r"sales?|penjualan|jualan|omzet|omset|konversi|closing|closingan|orderan|"
    r"revenue|gmv"
)
_FOCUS_AWARENESS = r"awareness|awarenes|awarness|branding|brand awareness|dikenal|exposure|eksposur"
_FOCUS_BOTH = r"keduanya|kedua ?nya|dua ?dua ?nya|duaduanya|semuanya|semua|both|ketiganya|tiga ?tiga ?nya"
_FOCUS_WORD = rf"{_FOCUS_SALES}|{_FOCUS_AWARENESS}|{_FOCUS_BOTH}"
#: Words allowed around a focus word without changing what the message is:
#: address, hedges, "lebih ke", "naikin", "dulu". Anything outside this list
#: — "kami", "tim", "turun", "berapa" — makes it a different sentence.
_FOCUS_FILLER = (
    r"halo|hai|kak|kakak|ka|kk|mba|mbak|pak|bu|min|lebih|ke|k|fokus|fokusnya|"
    r"utama|utamanya|nya|mau|maunya|pengen|pengin|ingin|untuk|utk|buat|"
    r"naikin|naikkan|menaikkan|meningkatkan|ningkatin|tingkatkan|peningkatan|"
    r"pertumbuhan|growth|dulu|dl|dlu|aja|saja|sih|ya|yah|deh|dong|kayaknya|"
    r"mungkin|kalau|kalo|klo|prefer|prioritas|target|targetnya|tujuannya|"
    r"objective|dan|and|sama|juga|plus|sekaligus|sekalian|yang|yg|biar|supaya|"
    r"banyak|brand|produk|di|ini|itu|sekarang|skrg|saat|ok|oke|baik|iya|iyah|"
    r"sip|siap|jadi|jd|si|nih|optimasi|optimalisasi|marketplace|toko"
)


def focus_of(text: str) -> str:
    """"sales" / "awareness" / "keduanya" / "" — which answer a focus reply
    carries. Both words together count as both."""
    norm = _normalise(text)
    both = re.search(rf"\b(?:{_FOCUS_BOTH})\b", norm)
    sales = re.search(rf"\b(?:{_FOCUS_SALES})\b", norm)
    aware = re.search(rf"\b(?:{_FOCUS_AWARENESS})\b", norm)
    if both or (sales and aware):
        return "keduanya"
    if sales:
        return "sales"
    if aware:
        return "awareness"
    return ""


#: What OUR message looks like when it asks for the focus — the templates
#: that end on "awareness, penjualan, atau keduanya?", the menu's
#: "kebutuhannya lebih ke mana", the greeting's "lebih fokus ke mana". The
#: engine checks the last outbound against this before letting a
#: FOKUS_CAMPAIGN reading stand.
_ASKS_FOCUS_RE = re.compile(
    r"awareness[^?]{0,60}(penjualan|sales)[^?]{0,40}\?"
    r"|(penjualan|sales)[^?]{0,60}awareness[^?]{0,40}\?"
    r"|(lebih|fokus)[^?]{0,20}ke mana[^?]{0,20}\?"
    r"|kebutuhan\w*[^?]{0,40}(apa|lebih ke)[^?]{0,30}\?"
    r"|fokus (utama|campaign)\w*[^?]{0,60}\?",
    re.IGNORECASE,
)


def asks_for_focus(outbound: str) -> bool:
    """Did this message of ours ask what the brand's focus is?"""
    return bool(outbound) and bool(_ASKS_FOCUS_RE.search(outbound))


#: Ordered rules. First match wins, so the most decisive intents come first.
#: Each entry: (intent, list of regex patterns).
_RULES: list[tuple[Intent, list[str]]] = [
    # --- hard stop, always honoured first ---------------------------------
    (
        Intent.OPT_OUT,
        [
            # Bare "STOP" is the unsubscribe keyword, but it is also how a
            # brand asks to end a CAMPAIGN — "di tengah periode mau stop
            # bisa?" was read as a permanent opt-out, which by the note below
            # kills the lead for good over a contract question. When the
            # message is about the engagement, this rule stands down; the
            # messaging-specific rule further down still catches "stop kirim
            # pesan", and TANYA_REFUND answers the contract version.
            r"^(?!.*\b(campaign|kontrak|kerja ?sama|periode|tengah jalan|refund)\b)"
            r".*\bstop\b",
            r"\bunsubscribe\b",
            # jgn joins jangan, and the object list widens: every one of
            # these was a real refusal the rules read as UNKNOWN, so the
            # ladder kept messaging someone who had told it to stop.
            #
            # But opt-out is permanent and irreversible — the contact is never
            # messaged again, at any point — so a false positive kills a live
            # lead for good. "jangan lupa kirim proposalnya ya kak" is a brand
            # ASKING for something and matched this rule; the exclusions below
            # are the ones that make the widening safe.
            r"\b(jangan|jgn)(?! (lupa|khawatir|sungkan|ragu|kaget|sampai))\b"
            r".*\b(hubungi|kirim|chat|telp|telpon|wa|whatsapp|spam|ganggu)\b",
            r"\b(jangan|jgn) di ?(hubungi|chat|wa)\b",
            r"\b(berhenti|hentikan|stop)\b.*\b(kirim|chat|pesan|hubungi|wa)\b",
            r"(hapus|remove) (nomor|kontak)",
            r"\bsalah sambung\b",
            r"\bnomor (pribadi|salah)\b",
            r"\bbukan (nomor|no|nmr) (toko|brand|usaha|perusahaan)\b",
            r"\b(lapor|laporkan|report)\b.*\b(spam|nomor|wa)\b",
            r"\bspam\b.*\b(jangan|jgn|berhenti|stop|lapor)\b",
            r"blokir",
        ],
    ),
    # --- rejection ---------------------------------------------------------
    (
        Intent.TOLAK_TEGAS,
        [
            r"(belum|blm|tidak|tdk|gak|ga|nggak|engga|kurang) (ter)?tarik",
            r"kurang (minat|cocok|sesuai)",
            r"\b(tidak|tdk|gak|ga|nggak|engga|blm|belum|kurang) ?(ber)?minat\b",
            r"(maaf|mohon maaf).*(tidak|tdk|belum|blm).*(tarik|minat|butuh)",
            r"sudah ada (vendor|agency|agensi|partner)",
            r"tidak (membutuhkan|perlu)",
            # A firm no the rules could not read means the ladder keeps
            # chasing someone who already declined — the complaint and ban
            # path. All of these came from stress-testing the rejection set.
            r"\bno,? thanks?\b",
            r"^(tidak|ga|gak|nggak|engga),? terima kasih\b",
            r"\bga ?usah\b",
            r"\b(kita|kami) (tolak|nolak)\b",
            r"\btolak (penawaran|tawaran)\w*",
            r"\b(ga|gak|nggak|engga|tidak|tdk) (ambil|jadi|lanjut|pake|pakai)\b",
            r"\bsudah (kami|kita) putuskan\b",
            r"\bkeputusan\w*\b.*\b(final|tolak|tidak)\b",
            r"\bjawaban kami tetap (tidak|ga|gak)\b",
            r"\b(tidak|ga|gak|nggak) (akan|bakal)\b.*\b(pake|pakai|ambil|agency)\b",
        ],
    ),
    (
        Intent.TOLAK_HALUS,
        [
            # Already handled elsewhere — an agency, an enabler, or a
            # third party. A soft no with a reason, not a brush-off.
            r"\b(dikelola|kelola|handle|ditangani) (oleh )?pihak ketiga\b",
            r"\btidak (kelola|mengelola) sendiri\b",
            r"\b(e[- ]?commerce )?enabler\b",
            # "jika nanti sudah ada kebutuhan akan kami coba hubungi
            # kembali ya" — a callback promise is a decline with a door
            # left ajar. Matched on the promise itself, not on a leading
            # nanti/jika/kalau: 20 Aug 2026 a brand answered the service
            # list with "Baik, kami akan hubungi kembali ya", which no rule
            # here saw, so the bare "Baik" took it to OK_LANJUT and the bot
            # replied by offering meeting slots and asking for an email —
            # then chased a meeting nobody had agreed to.
            r"\b(hubungi|kontak|contact)\w*\b\s*(kami|kita|anda|kakak|kak)?\s*"
            r"\b(kembali|lagi|balik)\b",
            r"\b(gak|ga|nggak|engga|tidak|tdk) dulu\b",
            r"belum butuh",
            r"belum ada (budget|rencana|plan|kebutuhan)",
            # The two commonest soft noes in the 14 Aug threads, both of which
            # the static rules missed entirely and only the LLM caught:
            # "halo kak saat ini belum" and "untuk saat ini kami belum
            # membutuhkan karna sudah ada team yang mengelola affiliate".
            r"\b(saat ini|untuk saat ini|sementara ini)\b[^.?!]{0,24}\bbelum\b",
            r"belum (membutuh|memerlu|tertarik|berminat|ada minat)",
            r"sudah ada (tim|team|vendor|agency|partner)[^.?!]{0,30}"
            r"(kelola|mengelola|handle|menangani|urus)",
            r"lain kali",
            r"mungkin nanti",
            # Real soft declines the first rules missed (see the gold set):
            # "kami belum bisa melanjutkan kerja sama ini", "beliau masih
            # merasa belum srek dengan konsep".
            r"belum (bisa|dapat) (me)?lanjut",
            r"belum (srek|sreg|cocok)",
            # The same soft declines as brands actually abbreviate them. The
            # rules above spell every word out; real refusals do not.
            r"\b(blm|belum) (dulu|dl|dlu)\b",
            r"\b(gak|ga|nggak|engga|tidak|tdk) (dl|dlu)\b",
            r"\b(udh|udah|sdh|sudah) ada (vendor|agency|agensi|partner)\b",
            r"\bbudget\w*\b.*\b(blm|belum) ada\b",
            r"\b(blm|belum) (cocok|butuh|ambil|perlu)\b",
            r"\bhandle (internal|sendiri)\b",
            r"\b(lg|lagi|masih)\b.*\b(ga|gak|nggak|belum|blm) ada plan\b",
            r"\boff (dl|dulu|dlu)\b",
            r"\bhasilnya kurang\b",
        ],
    ),
    # --- inbound: the lead wrote first ------------------------------------
    # Placed after rejection (a "no" always wins) and before the question
    # rules, because both of these are recognised by SHAPE, not by topic —
    # the generic "info" and "berapa" rules below would otherwise swallow
    # them and answer a question nobody asked.
    #
    # Both patterns are written against NORMALISED text (see `_normalise`):
    # lowercase, and every character outside [a-z0-9 ?] replaced by a space.
    # Colons, asterisks and brackets are gone by the time a rule runs, so a
    # rule that leans on punctuation matches nothing and fails silently.
    (
        # WhatsApp's own pre-filled text from an ad or catalogue CTA. Nobody
        # types these: the brand tapped a button and WhatsApp wrote the
        # message. 12 of 430 turns in inbound/ are exactly this sentence,
        # which makes it the most common opening line the bot will ever see.
        #
        # Matched as the fixed strings they are, whole-message. A loose
        # "minta info" rule here would eat every genuine request for
        # information, and those need answering on their merits.
        #
        # NOT here, deliberately: "[Spesial offer] Saya tertarik untuk Paket
        # 150 affiliate" — the other pre-filled CTA, 14 turns. It names a
        # package we no longer sell, and TANYA_PAKET_LAMA further down says
        # so ("paket tersebut sudah tidak tersedia… paket yang berjalan
        # sekarang…"). Claiming it as a bare ad lead would drop that
        # correction, and the brand would hear the real price for the first
        # time much later — which is the shape of a bait. At Node.NEW both
        # intents send the qualification form anyway, so the only thing this
        # choice changes is what happens when it arrives mid-conversation,
        # and there the correction is what serves the brand.
        Intent.LEAD_IKLAN,
        [
            r"^halo bisa minta info lebih lanjut tentang ini ?\??$",
            r"^hello can i get more info on this ?\??$",
            r"^hi i d like to know more about this ?\??$",
        ],
    ),
    (
        # The qualification form, filled in — the turn the whole inbound SOP
        # waits for. Two shapes in the corpus, and the rule has to read both:
        # typed out ("Nama brand : X, Posisi : owner, link: …"), and our own
        # message copied back with values written after the colons (ten turns
        # across ten different conversations do exactly that).
        #
        # Colons do not survive normalisation, so "filled in" cannot be read
        # from punctuation. What distinguishes a filled form from the blank
        # one we sent is that a field label is followed by a VALUE rather
        # than by the next field label — so every pattern below requires a
        # word after the label that is not itself a label.
        # TWO fields, not one. A single "posisi …" is not a form: "Posisi
        # kalian di mana ya" is a brand asking where our office is, and a
        # one-field rule stole it from TANYA_LOKASI — the answer to which is
        # about legitimacy, the thing a stranger is actually worried about.
        Intent.ISI_FORM,
        [
            # A named brand/shop AND some other field mentioned anywhere in
            # the message: "Nama Brand: brand uji … Link: …", and
            # "Saya [nama] Nama Toko [brand] di TikTok Shop".
            #
            # What follows the label must be a NAME. The first version asked
            # only for "some word", which made every sentence that happens to
            # contain "nama brand" and "link/tiktok" a filled form:
            # "nama brand kami sudah tutup kak, link shopee nya sudah tidak
            # aktif" was read as form data — and at a scheduling node that
            # booked a Google Meet with a brand that had just said it closed.
            # A brand never writes "Nama Brand: kami" or "Nama Brand: yang";
            # those words start a clause, not a value.
            r"(?=.*\bnama (brand|toko|perusahaan|usaha)\s+"
            r"(?!posisi|link|nama|shopee|tiktok|email|phone|kami|saya|kita|sy|"
            r"nya|itu|ini|apa|yg|yang|belum|blm|sudah|sdh|udah|udh|masih|"
            r"tidak|tdk|gak|ga|nggak|mau|bisa|boleh|kalau|klo|untuk|utk\b)"
            r"[a-z0-9])"
            r"(?=.*\b(posisi|jabatan|link|shopee|tiktok|tokopedia)\b)",
            # "1 nama seedperapat 2 posisi owner 3 shopee link" — numbered,
            # after the dots and colons are stripped by normalisation.
            r"\b\d\s+nama\s+(?!posisi|link|nama\b)[a-z0-9][\s\S]{0,80}"
            r"\b\d\s+(posisi|jabatan|shopee|tiktok|link)\b",
            # ONE label, when it is the whole message: "Nama Brand: brand uji,
            # frozen food" sent mid-chat after we asked for the
            # form. The two-field rule above needs a second label; this
            # one needs the message to START with the label, carry a name,
            # and ask nothing — the same exclusions keep "nama brand kami
            # sudah tutup" and "nama brand yang di tiktok itu mcnasia atau
            # spark?" out (24 Sep 2026).
            r"^nama (brand|toko|usaha|perusahaan)\s+"
            r"(?!posisi|link|nama|shopee|tiktok|email|phone|kami|saya|kita|sy|"
            r"nya|itu|ini|apa|yg|yang|belum|blm|sudah|sdh|udah|udh|masih|"
            r"tidak|tdk|gak|ga|nggak|mau|bisa|boleh|kalau|klo|untuk|utk\b)"
            r"[a-z0-9][^?]{0,80}$",
        ],
    ),
    # --- specific deferrals, before anything generic -----------------------
    (
        # "Mohon kirimkan proposal melalui email clarita.pinky@..." — a request
        # for a proposal, NOT the email that books a Google Meet. The flow
        # tells those two apart by node; this only says an address was offered
        # in the same breath as a request to send something.
        Intent.KIRIM_EMAIL,
        [
            r"(kirim(kan)?|send|share|sampaikan)[^.?!]{0,40}"
            r"(proposal|penawaran|company profile|materi|deck)"
            r"[^.?!]{0,40}(email|e-mail|mail)",
            r"(email|e-mail)[^.?!]{0,30}(berikut|ini|di ?bawah)[^.?!]{0,20}"
            r"[\w.+-]+@[\w-]+\.[\w.]+",
            r"(kirim|sampaikan|teruskan)[^.?!]{0,20}ke[^.?!]{0,10}"
            r"[\w.+-]+@[\w-]+\.[\w.]+",
        ],
    ),
    (
        # "Untuk kebutuhan B2B dan negosiasi, saya akan hubungkan Kakak dengan
        # tim sales kami." A promised introduction is not an introduction — the
        # reply asks for the contact.
        Intent.HUBUNGKAN_PIC,
        [
            r"(akan|saya|kami|nanti)[^.?!]{0,24}"
            r"(hubungkan|sambungkan|connect(kan)?|arahkan)"
            r"[^.?!]{0,30}(tim|team|pic|bagian|divisi)",
            r"(hubungkan|sambungkan)[^.?!]{0,20}(dengan|ke)[^.?!]{0,20}"
            r"(tim|team) (sales|marketing|b2b|terkait)",
            # A redirect with NO number attached: "kaka bisa hubungi yang
            # berkait ya", "Bisa hub bagian online kita". The referral capture
            # only fires when there is a number to queue, so without one these
            # reached nobody at all. The answer is to ask for the contact.
            r"\b(bisa|boleh|silakan|silahkan|dapat) (hub|hubungi|kontak)\b"
            r"[^.?!]{0,30}\b(bagian|divisi|tim|team|berkait|pic|orang)\b",
            # "menghubungi" — the prefix breaks a \b, so match the object
            # instead of the verb.
            r"\b(kontak|nomor|no) yang (tadi|sudah|barusan|di ?atas)\b",
            # "sudah diluar dari kapasitas divisi kami" / "akses Danny
            # terbatas" — the right answer is the same: who should we talk to?
            r"\b(di ?luar|diluar)( dari)? kapasitas\b",
            r"\bakses \w+ terbatas\b",
        ],
    ),
    (
        # "Untuk produk yang sebelumnya kami miliki, mohon maaf kami sudah
        # tidak produksi lagi." The brand is still there, doing something else.
        Intent.PRODUK_BERUBAH,
        [
            r"(sudah|sdh|udah|tidak|tdk|ga|gak) ?(tidak|lagi)?[^.?!]{0,16}"
            r"(produksi|produks|memproduksi|jual|berjualan)[^.?!]{0,12}(lagi|lg)",
            r"produk[^.?!]{0,30}(sudah|sdh|udah)[^.?!]{0,16}"
            r"(tidak|tdk|ga|gak)[^.?!]{0,16}(ada|produksi|dijual)",
            r"(brand|usaha|bisnis)[^.?!]{0,16}(sudah|sdh) (tutup|berhenti|ganti)",
        ],
    ),
    (
        Intent.TERUSKAN_TIM,
        [
            # \b on the second group: without it "tim" matches inside
            # "timeline", which misrouted the NORDES English RFP here.
            r"(teruskan|forward|sampaikan|share|diskusikan|ajukan|naikan|naikkan)"
            r".*\b(tim|team|atasan|manajemen|bos|owner|leader)\b",
            # pusat means HQ-as-decision-maker, but "mau tanya untuk kantor
            # pusat … itu dimana yaa" is a location question — exclude it.
            r"(tanya|konfirmasi|cek).*\b(tim|team|atasan|manajemen|bos|(?<!kantor )pusat)\b",
            r"koordinasi(kan)? dulu",
            # "atasan" joins tim/team: "harus di scedhule dlu sama atasan ku
            # juga, nanti kita berkabar yaa".
            r"\b(tim|team|atasan)\b.*(dulu|nanti)",
            # "Bntar ya Mas, belum ketemu waktu untuk ngobrol dengan owner
            # soalnya" — the decision-maker chat hasn't happened yet.
            r"(ngobrol|bicara|ketemu)\w*.*\b(owner|atasan|bos|manajemen|tim|team)\b",
            r"\brunding\w*\b",  # "sy rundingkan dl" — deliberate internally
            # Mixed-language deferrals seen in the exports.
            r"get back to you",
            r"(masih|still) dalam proses discussion",
        ],
    ),
    (
        Intent.PELAJARI_DULU,
        [
            # \b on dl: bare ".*dl" also matches inside words ("dihandle"),
            # stealing e.g. "bisa lihat dashboard brand yg dihandle?".
            # dlu joins dl: "Bntr kak ak liat jdwl ku dlu kak".
            # \b in front too (24 Sep 2026): "liat" is inside "affiLIATe", so
            # any message naming affiliate and ending "dulu" — "ada paket
            # affiliate yg lebih rendah untuk percobaan dulu?" — was a
            # study-first deferral, parked on the follow-up ladder instead
            # of answered.
            r"\b(pelajari|baca|review|liat|lihat|cek|pertimbang).*\b(dulu|dl|dlu)\b",
            r"dipelajari dulu",
            r"saya (pelajari|pikirkan|pertimbangkan)",
            # "Sy mikir2 dl ya kak", "aku pikir-pikir dulu" — the same
            # study-first deferral, in the words brands use (24 Sep 2026).
            r"\b(mikir|pikir|pikirin|mikirin|pikirkan|pertimbangin|timbang)\w*\b.{0,12}\b(dulu|dl|dlu)\b",
        ],
    ),
    (
        # "Bentar saya cek ya", "Kmi baru slsai sbntr ya kak" — hold on, no
        # request in it. Today these burn an unknown strike each, so two in a
        # row hand the conversation to a human while the brand is mid-errand.
        #
        # Must stay BELOW PELAJARI_DULU: "Bntr kak ak liat jdwl ku dlu kak" is
        # a study-first deferral in the gold set, and a bare ^bntr rule placed
        # higher would take it. The [^?]*$ guard (as OK_LANJUT uses) lets
        # "bentar, harganya berapa?" fall through to the price bucket.
        Intent.TUNGGU,
        [
            r"^(bentar|bntar|bntr|sebentar|sbntar|sbntr|tunggu|sabar|wait)\b[^?]*$",
            r"\b(bentar|bntar|bntr|sebentar|sbntar|sbntr)\b[^?]*\b(ya|dulu|dl|kak|ka)\b[^?]*$",
            r"\byuk wait\b|\bwait ya\b",
        ],
    ),
    # --- specific questions, before the generic ones -----------------------
    # Each of these recurs across the chat-example exports; keep them ahead of
    # TANYA_HARGA/TANYA_SISTEM so "komisi berapa" or "berapa lama prosesnya"
    # don't fall into the generic price bucket.
    (
        Intent.MINTA_KONTRAK,
        [
            r"(kirim|minta|lihat|liat|share|drop|buat)\w*.*(kontrak|agreement|perjanjian|draft|mou)",
            r"(kontrak|agreement|draft|mou|perjanjian)\w*.*(dulu|review|dipelajari|legal|tim)",
        ],
    ),
    (
        # Every pattern is guarded against a named time or day. "Apa bisa
        # zoom meeting besok Selasa jam 10.00? … link" is a brand proposing a
        # meeting; reading it as a resend request loses the booking. Position
        # cannot express that — placed lower, "boleh di wa link Zoom nya" is
        # taken by MINTA_TELEPON on the word "zoom" — so the guard rides on
        # the patterns instead.
        # "link nya ka", "kirim kesini aja kk link nya ya kk", "tlg
        # remindernya ulang" — asking us to (re)send something, usually the
        # Meet link of a meeting already booked.
        Intent.MINTA_LINK,
        [
            r"^(?!.*\b(jam ?\d|besok|lusa|senin|selasa|rabu|kamis|jumat|sabtu)\b)link ?nya( ada)?\b[^?]*\??$",
            # "boleh share link dashboard?" is a portfolio question, not a
            # request to resend the meeting link — let it fall through.
            # \b so a verb is not found inside another word, and "kasih" only
            # as "give" — "terima kasih … di link" is a business auto-reply
            # thanking you, not a request to send anything.
            r"^(?!.*\b(jam ?\d|besok|lusa|senin|selasa|rabu|kamis|jumat|sabtu)\b)(?!.*dashboard).*\b(kirim|krm|minta|share|(?<!terima )kasih|ksh|bagi|wa)\w*"
            r".*\blink\w*\b",
            # Guarded by a request verb: without it this steals OK_LANJUT's
            # "thankyou untuk reminder nya ya kakk", a plain acknowledgement.
            r"^(?!.*\b(jam ?\d|besok|lusa|senin|selasa|rabu|kamis|jumat|sabtu)\b).*(tlg|tolong|minta|kirim|share|send|resend)\w*.*\breminder\w*",
            r"^(?!.*\b(jam ?\d|besok|lusa|senin|selasa|rabu|kamis|jumat|sabtu)\b).*\breminder\w*\b.*\b(ulang|lagi|lg)\b",
        ],
    ),
    (
        # "kaka tau nomor saya dari mana?" — asked about their own privacy.
        # High in the order because the answer is a compliance statement, not
        # a sales one, and because nothing else was catching it: on 30 Jul 2026
        # it reached UNKNOWN and the generator invented "dari data publik
        # terkait informasi bisnis".
        Intent.TANYA_SUMBER_KONTAK,
        [
            r"\b(tau|tahu|dapat|dapet|dpt|peroleh|dpet)\w*\b.{0,25}"
            r"\b(nomor|no|kontak|wa|whatsapp)\b.{0,25}\bdari ?mana\b",
            r"\bdari ?mana\b.{0,25}\b(nomor|kontak)\w*\b",
            r"\b(nomor|kontak)\w*\b.{0,25}\bdari ?mana\b",
            r"\b(kok|kenapa|gimana|gmn)\b.{0,20}\b(tau|tahu)\b.{0,20}"
            r"\b(nomor|kontak)\w*\b",
            r"\b(dapat|dapet|peroleh)\w*\b\s+(nomor|kontak)\w*\s+(saya|aku|kami)\b",
        ],
    ),
    (
        # The ads service line, which is a different product from the affiliate
        # campaign and has its own deck. Sits above MINTA_CHAT so "boleh share
        # untuk paket ads" ships the ads deck rather than the company profile,
        # and above TANYA_HARGA/TANYA_SISTEM so "berapa untuk ads?" is answered
        # about ads instead of quoting the affiliate packages.
        #
        # Every pattern is question- or service-shaped, never a bare "ads":
        # brands list their own ad spend when they introduce themselves ("ada
        # pakai ads juga", gold f11) and that is not a question for us.
        Intent.TANYA_ADS,
        [
            r"\b(service|layanan|paket|jasa|handle|manage|kelola|urus|bantu|pegang)"
            r"\w*( \w+){0,2} \b(ads|iklan|advertising|adv)\b",
            r"\b(tik ?tok|shopee|meta|fb|facebook|ig|instagram) ?ads\b",
            r"\bads (management|manage\w*|service|maintenance)\b",
            r"\bgmv ?max\b",
            # A reply picking the ads line off COLD_FU2's service menu:
            # "yang ads dong", "ads nya kak".
            r"\b(yang|yg) (ads|iklan)\b",
            r"\b(ads|iklan)\s*(nya)?\s*(dong|aja|saja|kak|ka)\b",
            # An outright question mentioning ads — "ada service ads gak?",
            # "bisa bantu iklan?". Question-marked or question-worded only.
            r"\b(ads|iklan|advertising)\b[^?]{0,60}\?",
            # Not when the brand is describing its OWN ad spend — "ada pakai
            # ads juga", "sudah coba ads sendiri". They are introducing
            # themselves, not asking what we offer.
            r"\b(ada|bisa|apakah|adakah)\b"
            r"(?![^.?]*\b(pakai|pake|coba|jalan\w*|running|sendiri)\b)"
            r"[^.?]{0,40}\b(ads|iklan|advertising)\b",
        ],
    ),
    (
        # "apakah bisa via chat saja? saya sdg tidak available" — declining
        # the meeting without declining the offer. Above MINTA_TELEPON so
        # "chat aja, gak usah call" is not read as wanting a call, and above
        # SETUJU so "bisa" here does not book anything.
        Intent.MINTA_CHAT,
        [
            # No bare "sini": "nah disini brlaku untuk itu gk ka?" is an
            # ordinary "here", not a request to stay in chat.
            r"\b(via|lewat|lwt|pakai|pake) ?(chat|wa|whatsapp)\b",
            r"\bchat (aja|saja|dulu)\b",
            r"\b(di ?)?(wa|whatsapp) (aja|saja)\b",
            r"\b(gak|ga|nggak|engga|tidak|tdk|tanpa) (usah |perlu )?(meeting|zoom|call|ketemu)\b",
            # "send it over first and I'll consider it" — the same request as
            # "chat aja", phrased as a demand for material instead of a refusal
            # of the meeting. A pilot tester wrote "kirim kan aja dulu biar aku
            # pertimbangkan"; it fell through to unknown and the bot answered
            # by asking for their email address for the Meet invite.
            # Not "kirim sample": that is TANYA_SAMPLE's, and it sits lower.
            # "bagi" is "send me", but "bagi hasil" is profit-sharing — a
            # commercial proposal, and TANYA_KOMISI_ONLY answers it.
            # Likewise "sharing" alone is fine, but "profit sharing" is the
            # same commercial proposal wearing an English word.
            r"\b(kirim|krim|kirimin|share|(?<!profit )sharing|bagi(?! ?hasil)|infoin)\w*\b"
            r"(?![^.]*\b(sampel|sample|produk)\b)"
            r"( \w+){0,3} (dulu|aja|saja)\b",
            # "boleh share untuk paket ads" — a request for the deck. Read as
            # SETUJU it booked a meeting the tester had not agreed to, which
            # is what provoked the complaint above. Excludes "share ke tim",
            # which is TERUSKAN_TIM.
            # No bare "minta": "boleh minta portofolionya" is a portfolio
            # question. The noun rule below still catches "boleh minta pricelist".
            r"\bboleh (di)?(share|kirim|sharing)\w*\b(?![^.]*\b(ke|sama|dgn|dengan) "
            r"(tim|team|atasan|bos|owner|manaje\w*)\b)",
            # No "pl"/"pricelist": asking for the price list is a price
            # question, and TANYA_HARGA answers it with the actual ladder.
            # Not when the meeting is where they want it: "kalau kita mau minta
            # dijelasin detail history penjualan ... pas meeting" is a brand
            # planning the agenda, and reading it as "skip the meeting" would
            # answer the one question they were saving for it.
            r"\b(kirim|share|minta)\w*( \w+){0,2} "
            r"(paket|detail|rincian|penawaran|proposal)\b"
            r"(?![^.]*\b(pas|saat|waktu|di|pada) (meeting|ketemu|zoom|call)\b)",
            # "ko langsung ngajak meeting sih kak" — an explicit complaint that
            # we are pushing. Whatever else the message asks for, the one thing
            # that must not follow is another meeting prompt.
            r"\b(ko|kok|kenapa|napa|ngapa) ([^.]{0,25} )?(langsung |buru.?buru )?"
            r"(ng?ajak|ajakin|nawarin|minta) ([^.]{0,15} )?(meeting|ketemu|zoom|call)\b",
            r"\blangsung ng?ajak(in)? (meeting|ketemu|zoom|call)\b",
        ],
    ),
    (
        # "ada rate card atau company profile?", "boleh minta deck nya kak",
        # "kirim compro dong" — a request for the document itself. Below
        # MINTA_CHAT ("kirim proposal dulu, aku pertimbangkan" keeps its
        # answer) and above TANYA_AFFILIATE, which used to own "rate card"
        # for an English RFP and answered a deck request with curation
        # criteria (24 Sep 2026). The corpus answer: send it, ask the need.
        Intent.MINTA_PROFILE,
        [
            r"\b(company profile|compro|comprof|profil perusahaan|company deck|rate ?card|ratecard)\b",
            r"\b(ada|minta|boleh|bisa|kirim|share|punya|mau|butuh)\b.{0,30}\b(deck|decknya|deck nya)\b",
        ],
    ),
    (
        # "saya dari agency", "kita handle beberapa klien yang ada kebutuhan
        # affiliate", "sudah ada rekanan lama, lgi cr vendor baru" — an
        # agency looking for a vendor for its clients. Unplaced since the
        # first inbound round (gold s01 kept it UNKNOWN); the corpus answer
        # is to welcome it, ask the category and the volume, and invite.
        # Above MINTA_TELEPON only by position; PERNAH_AGENCY ("pernah pakai
        # agency, gak ada hasil") is ranked well above and keeps its turn.
        Intent.AGENCY_VENDOR,
        [
            r"\b(saya|sy|kami|kita|aku) (dari|dr|di) (agency|agensi)\b",
            r"\b(agency|agensi) (saya|kami|kita)\b",
            r"\b(handle|pegang|megang|urus|ngurus)\w*\b.{0,20}\b(beberapa |banyak |bbrp )?(klien|client|customer)\b",
            r"\b(klien|client) (kami|kita)\b",
            r"\b(cari|nyari|mencari|cr|butuh|perlu)\b.{0,20}\b(vendor|rekanan|partner agency|agency affiliator|mitra)\b",
        ],
    ),
    (
        Intent.MINTA_TELEPON,
        [
            r"\b(telepon|telpon|telfon|telp|tlf|tlp)\b",
            r"\bcall\b",
            r"\bzoom\b",
            r"\b(vc|video ?call)\b",
        ],
    ),
    # --- time/day proposals = agreement, ahead of the generic questions ------
    # The single largest miss in the gold set: brands book meetings by naming
    # a slot ("Jam 4 aja", "Senin bagaimana?", "besok jam 1 gmn?"), and the
    # generic berapa/gimana rules used to swallow them. Ranked after
    # MINTA_TELEPON so "jam 2, saya ijin call ya" still steers to Meet.
    (
        Intent.SETUJU,
        [
            r"\bjam \d{1,2}\b",
            # bsk joins the day names: "Malam ka, bsk bs ka?"
            #
            # The day word has to OPEN its clause — start of message, after
            # punctuation, or after a connector. Naming a slot reads that way
            # ("besok jam 10 bisa kak?", "untuk hari ini bisa quick meet",
            # "Malam ka, bsk bs ka?"). A day word sitting straight after a
            # content noun is instead describing that noun, and matching it
            # swallowed anything shaped like "<topic> hari ini gimana": a
            # tester's "cuaca hari ini gimana kak?" was read as agreeing to a
            # meeting, so the bot replied by asking for their email.
            # _normalise strips punctuation before these run, so the clause
            # break has to be spelled out as words: "Ka jd gimana, bsk bs ka?"
            # arrives as "ka jd gimana bsk bs ka?", where `gimana` is what ends
            # the previous clause. Listing it here is safe — the false positive
            # has the question word AFTER the day word, never before it.
            r"(?:^|[,.!?;]\s*|\b(?:kalau|kalo|klo|klau|untuk|utk|jadi|jd|aja|"
            r"banget|deh|dong|ya|yaa|dan|atau|tapi|kak|ka|mba|mbak|pak|bu|"
            r"gimana|gmn|bagaimana|halo|hallo|haloo|pagi|siang|sore|malam|"
            r"maaf|sorry|sori)\s+)"
            r"(hari ini|besok|bsk|lusa|senin|selasa|rabu|kamis|jumat|sabtu)\b"
            r".*\b(bagaimana|gimana|gmn|bisa|bs|boleh|blh|aman|oke|ok|ya|yah)\b",
            # bsa joins bisa/bs: "Sorry bru bsa respon / Bsa meeting di Rabu ?"
            r"\b(bisa|bsa|bs|boleh|blh|gimana kalau|kalau)\b"
            r".*\b(hari ini|besok|lusa|senin|selasa|rabu|kamis|jumat|sabtu)\b",
            r"\b(bisa|bs)\b.*\b(discuss|ngobrol|quick meet)\b",
            # "rabu aja kalo gitu", "besok aja ya" — a day with "aja" after
            # it is a counter-proposal, whatever came before it. Found in
            # inbound/ as "saya masih di jalan jam segitu | rabu aja kalo
            # gitu": the actionable half is Wednesday, and reading the first
            # half as a deferral would answer "no rush" to someone who just
            # named a day.
            # "X aja" also means "even X" / "only X": "jangan besok aja",
            # "sabtu aja kami libur", "hari ini aja belum sempat baca". Those
            # are a refusal, a closure and a deferral — and read as SETUJU
            # each one produced a slot list and counted as acceptance on the
            # dashboard. The guard excludes a preceding "jangan" and the
            # unavailability words that give the phrase its other meaning.
            r"^(?!.*\bjangan\b)"
            r"(?!.*\b(sibuk|libur|belum|blm|gak bisa|ga bisa|tidak bisa|tdk bisa|belum tentu)\b)"
            r".*\b(hari ini|besok|bsk|lusa|senin|selasa|rabu|kamis|jumat|sabtu)\s+"
            r"(aja|saja|sja)\b",
            # "kira kira minggu depan apakah bisa?" — naming a week is
            # naming a time.
            r"\b(minggu|pekan) depan\b[^?]*\b(bisa|bs|boleh|blh|gimana|gmn|apakah)\b",
            r"\b(bisa|bs|boleh|blh|maunya|prefer)\b[^?]*\b(minggu|pekan) depan\b",
            # Bare clock times, no "jam": "17. 15 ya..ini baru mau  sholat",
            # "Ka aku minta mundur 14.30 blh?". Two-digit minutes keep prices
            # ("15 000 000") and dates ("29 juni") out.
            r"\b\d{1,2} \d{2}\b.*\b(ya|yah|blh|boleh|bisa|bsa|bs|ok|oke|aja|aman)\b",
            # Reschedule proposals stay scheduling, not deferral: "Kalau di
            # ganti hari lain berarti gk bsa ya kak". No \w* prefix on undur —
            # "Jangan diundur lagi" (a location complaint) must not land here.
            r"\b(ganti|ubah|mundur|undur|reschedule|resched)\w*"
            r".*\b(hari|jam|jadwal|waktu)\b",
            # Day-part proposals: "kalau di sore hari apakah bisa ?". All
            # three anchors required — bare "siang kak" greetings + a stray
            # "ya" would match anything looser.
            r"\b(kalau|kalo|klo)\b.*\b(pagi|siang|sore|malam)\b"
            r".*\b(bisa|bsa|bs|boleh|blh)\b",
            # The same offer with the availability word first: "mungkin bisa
            # ka sore nanti", "bisa nya besok pagi". A day-part next to an
            # availability word IS a slot proposal — the greeting case is
            # excluded because "sore kak" alone has no bisa/boleh in it.
            # Only particles may sit between, never a content noun: "boleh
            # minta katalog sore ini?" is a catalogue request that an open
            # gap swallowed into scheduling (the same trap as "cuaca hari
            # ini gimana" in the gold set).
            r"\b(bisa|bsa|bs|boleh|blh|available)\b"
            r"(\s+(ka|kak|kk|nya|ny|aja|saja|ya|di|pas|nanti|besok|bsk|bsok))*"
            r"\s+(pagi|siang|sore|malam)\b",
            r"\b(pagi|siang|sore|malam)\b\s+(ini\s+)?(nanti|aja|saja|az)\b",
        ],
    ),
    (
        # A counter-offer on the MCN commission, with their figure in it:
        # "Kalau komisi ke mcnasia nego di 5% gimana?". Must sit above both
        # TANYA_KOMISI (which would recite our 10% opening and never address
        # the number) and NEGO_HARGA (whose answer is about the package price
        # being nett, a different subject).
        #
        # A figure is required. Without one — "bisa nego komisi ke mcn?" —
        # there is nothing to take to management, and NEGO_HARGA's "sampaikan
        # angka yang diharapkan" is the right ask.
        # A bare figure next to "komisi" is NOT enough: `_normalise` strips
        # punctuation, so the whole message is one flat string and the gold
        # set's "Itu kan komisi ada komisi 10% utk MCN ... Jadi double dong?"
        # would match — a brand asking how the split works, quoting a number
        # we told them. A proposal cue has to be present too.
        Intent.NEGO_KOMISI,
        [
            r"^(?=.*\b(nego\w*|kalau|kalo|klo|gimana|gmana|gmn|gmna|bagaimana"
            r"|bisa|bsa|bs|boleh|blh|minta|request)\b)"
            r".*\b(komisi|commission|fee)\b.{0,40}?"
            r"\b\d{1,2}(?:[.,]\d+)?\s*(?:%|persen)\b",
            r"^(?=.*\b(nego\w*|kalau|kalo|klo|gimana|gmana|gmn|gmna|bagaimana"
            r"|bisa|bsa|bs|boleh|blh|minta|request)\b)"
            r".*\b\d{1,2}(?:[.,]\d+)?\s*(?:%|persen)\b.{0,40}?"
            r"\b(komisi|commission)\b",
        ],
    ),
    (
        Intent.NEGO_HARGA,
        [
            # "kurang" alone is ambiguous — "kurang paham/jelas" is not a
            # discount ask, so exclude those continuations explicitly.
            r"(bisa|bs|boleh|blh)\w*.*"
            r"(kurang(?!\s+(paham|jelas|ngerti|mengerti|tau|tahu))|nego|diskon|turun|murah)",
            r"(nego|diskon)\w*\b.*(harga|fee|paket|dikit|lagi|lg\b|bisa|bs\b|boleh)",
            r"minta di ?kurang",
            # A figure after it changes the question: "ada potongan 18% y?"
            # asks what the commission cut is, not for a discount.
            r"ada (diskon|potongan)\b(?!\s*\d)",
            # Discount asks the price rules were answering with the ladder.
            # The difference matters: a negotiation escalates to a human,
            # because only management can approve a number.
            r"\bharga khusus\b",
            r"\b(diskon|potongan)\w*\b.*\b(brp|berapa)\b",
            r"\bbest price\b",
            r"\bdigoyang\b",
            r"\bberat (bgt|banget|bener)\b",
            r"\bbudget\w*\b.*\b(mentok|maks|maksimal|cuma|hanya)\b",
            r"\b(samain|samakan|nyamain|nyaingin)\b",
            r"\bsetengah harga\b",
            r"\b(jadiin|jadikan) \d+\b",
            r"\b(bs|bisa) dibantu\b",
            r"\b\d+ (gimana|gmn)\b",
            # "Itu 10jt punya gak bisa dapat affliat 150 / Lg ramadhan gt
            # promo haha" — asking for promotional pricing is a discount ask.
            # "promo" and "promonya" only: the old `promo\w*` also matched
            # "promosiin" in "udah 2x pernah dipromosiin tapi gak ada hasil",
            # so a burned brand's objection was answered with "harga sudah
            # nett" (24 Sep 2026; PERNAH_AGENCY now owns that turn).
            r"\bpromo(nya|an)?\b",
        ],
    ),
    # --- facts BD supplied 30 Jul 2026 -------------------------------------
    # All seven sit above the generic question rules, which were answering
    # them with whatever matched first: "timnya berapa orang" got the price
    # ladder, "videonya boleh kami repost ga?" got a meeting booking.
    (
        Intent.TANYA_LEGALITAS,
        [
            r"\bnpwp\b|\bakta\b|\bsiup\b|\bnib\b",
            r"\b(pt|cv)\b\s*(nya|-?nya)?\b.{0,15}\b(apa|nama|mana)\b",
            r"\b(badan hukum|legalitas|legal)\w*\b",
            r"\b(perusahaan|company)\w*\b.{0,20}\b(resmi|terdaftar|legal)\b",
        ],
    ),
    (
        Intent.TANYA_REFUND,
        [
            r"\brefund\w*\b|\buang kembali\b|\bdikembalikan\b",
            r"\b(berhenti|stop|putus|batal|cancel|keluar)\w*\b.{0,25}"
            r"\b(tengah|jalan|kontrak|kerja ?sama|campaign)\b",
            # Reversed: "kalau di tengah jalan mau berhenti gimana?" puts the
            # period first and the verb last.
            r"\b(tengah jalan|tengah periode|tengah kontrak)\b.{0,30}"
            r"\b(berhenti|stop|putus|batal|cancel|keluar|mundur)\w*\b",
            r"\bkontrak\w*\b.{0,20}\b(diputus|putus|batal|dibatalkan)\b",
            r"\b(gagal|tidak sesuai|ga sesuai|gak sesuai)\b.{0,20}\b(gimana|gmn|refund|uang)\b",
        ],
    ),
    (
        # "Kalau udh 4 bulan itu vt nya bakal di privasi atau gimana ka?",
        # "setelah kontrak videonya dihapus?" — what happens to the videos
        # after the period. Above TANYA_HAK_KONTEN (rights) and TANYA_SISTEM
        # (which gave the generic answer); knowledge.CONTENT_AFTER_CONTRACT
        # holds the fact (24 Sep 2026).
        Intent.TANYA_VIDEO_SETELAH_KONTRAK,
        [
            r"\b(vt|video|videonya|konten|kontennya)\w*\b.{0,40}"
            r"\b(privasi|private|diprivat|dihapus|hapus|takedown|take down|hilang|ditarik|tetap ada|masih ada|masih tayang)\b",
            r"\b(setelah|sesudah|after|habis|selesai|berakhir|udah|sudah)\b.{0,12}\b(kontrak|periode|campaign|bulan)\b.{0,30}"
            r"\b(vt|video|videonya|konten|kontennya)\w*\b",
        ],
    ),
    (
        Intent.TANYA_HAK_KONTEN,
        [
            r"\bhak cipta\b|\bcopyright\b|\bhak (guna|pakai|milik)\b",
            r"\b(konten|video|kontennya|videonya)\b.{0,25}"
            r"\b(repost|re-?upload|dipakai|kami pakai|milik|punya siapa|hak)\b",
            r"\b(boleh|bisa)\b.{0,20}\b(repost|re-?upload)\b",
        ],
    ),
    (
        # Every pattern requires a question mark. These are keywords a brand
        # also uses to describe ITSELF — a NORDES intro in the gold set says
        # "exclusive" in passing, and matching it turned a self-introduction
        # into an answer about competitor conflicts.
        Intent.TANYA_EKSKLUSIVITAS,
        [
            r"^(?=.*\?)(?=.*\b(kompetitor|kompetiter|pesaing|competitor|saingan)\b)",
            # "Paket Custom Eksklusif" is a PRODUCT on the 18 Sep deck, not a
            # question about competitor conflicts — a brand naming it and
            # asking what it is was being answered with our policy on
            # handling rival brands. The word only carries its old meaning
            # when "paket" is not sitting right in front of it.
            r"^(?!.*\bpaket\b.{0,24}eksklusi)"
            r"(?=.*\?)(?=.*(\beksklusi\w*\b|\bexclusive\b))",
            r"^(?=.*\?)(?=.*\b(brand|produk)\w*\b.{0,20}\b(sejenis|serupa|sama)\b"
            r".{0,25}\b(handle|tangani|pegang|kerja ?sama)\w*\b)",
        ],
    ),
    (
        Intent.TANYA_REKENING,
        [
            r"\b(rekening|rek|norek|no\.? ?rek)\b",
            r"\btransfer\w*\b.{0,20}\b(ke ?mana|kemana|mana|bank)\b",
            r"\bbank\w*\b.{0,15}\b(apa|mana)\b",
            r"\batas nama\b",
        ],
    ),
    (
        Intent.TANYA_KATEGORI_PRODUK,
        [
            r"\b(rokok|tembakau|vape|alkohol|miras|obat keras|senjata)\b",
            r"\bhalal\b",
            r"\b(bpom|izin edar|izin khusus|sertifika\w*)\b",
            r"\bproduk\w*\b.{0,20}\b(terlarang|dilarang|boleh|diperbolehkan)\b",
            # "Klo produk digital itu apakah bisa jualan di shopee dan
            # tiktok shop?" — a product-type fit question. The team's
            # answer (Shopee no, TikTok yes via a taplink) is product
            # knowledge from ONE conversation, so it is not in the bank; the
            # template says the platform-policy rule and promises a check
            # with the team, and the flow escalates so the check happens.
            # Before this it was UNKNOWN — and the second UNKNOWN in a row
            # is the handover, whose opening line reads as a goodbye.
            r"\bproduk (digital|jasa|virtual|non ?fisik)\b.{0,40}\b(bisa|bs|boleh|masuk|jualan|dijual)\b",
        ],
    ),
    (
        # The brand's own inventory. Above TANYA_HARGA, whose bare "berapa"
        # rule was answering "minimal stok berapa yang harus disiapkan?" with
        # the price ladder. Anchored on stok/stock so it never takes the
        # sample-logistics questions TANYA_SAMPLE owns ("sample nya berapa
        # pcs?", "kalau sample hilang gimana?").
        Intent.TANYA_STOK,
        [
            r"\b(stok|stock)\w*\b.{0,25}"
            r"\b(berapa|brp|brapa|minimal|minimum|siap\w*|sedia\w*|habis|kosong|sold ?out)\b",
            r"\b(berapa|brp|brapa|minimal|minimum|siap\w*|sedia\w*|habis|kosong|sold ?out)\b"
            r".{0,25}\b(stok|stock)\w*\b",
            r"\bsold ?out\b",
        ],
    ),
    (
        Intent.TANYA_JANGKAUAN,
        [
            r"\b(luar|diluar|di luar)\s+(jakarta|jabodetabek|pulau|jawa|kota|negeri|indonesia)\b",
            r"\b(seluruh|semua)\s+(indonesia|wilayah|daerah|kota)\b",
            r"\b(brand|kami|toko|usaha)\w*\b.{0,20}\bdi\s+(bali|medan|surabaya|bandung|makassar|semarang|jogja|yogyakarta)\b",
            r"\b(bisa|melayani|handle)\w*\b.{0,20}\b(luar kota|luar pulau|luar negeri)\b",
        ],
    ),
    (
        # "apakah ada target penjualan?" — what results do you promise. Above
        # TANYA_SAMPLE, TANYA_HARGA and TANYA_SISTEM, all of which used to
        # take pieces of this and answer something else: "ada garansi
        # penjualan ga kak?" reached TANYA_SAMPLE and came back with the
        # sample-replacement guarantee, which reads as a yes.
        Intent.TANYA_TARGET,
        [
            r"\btarget\b.{0,20}\b(sales|penjualan|gmv|omzet|omset)\b",
            r"\b(sales|penjualan|gmv|omzet|omset)\b.{0,20}\btarget\b",
            r"\b(garansi|jaminan|jamin\w*|dijamin)\b.{0,25}"
            r"\b(penjualan|sales|gmv|omzet|omset|laku|hasil|balik modal|roi)\b",
            r"\b(naik|meningkat|nambah)\w*\b.{0,15}\bberapa\b",
            r"\bberapa\b.{0,15}\b(naik|kenaikan|peningkatan)\w*\b",
            r"\bkalau?\b.{0,10}\b(gak|ga|nggak|tidak|tdk|gk)\s*(laku|laris|ada yang beli|kejual)\b",
            r"\b(balik modal|roi|return)\b",
            r"\b(rugi|gagal)\b.{0,20}\b(gimana|gmn|bagaimana|siapa)\b",
            # "Ada garansi g ka? Dengan harga segitu?" — a guarantee asked
            # for against the price, with nothing said about samples. That
            # is the results question, and the sample-replacement answer
            # reads as "yes, we guarantee it" (24 Sep 2026, inbound/).
            r"\b(ada|apakah ada|adakah) garansi\w*\b"
            r"(?![^?]*\b(sample|sampel|video|upload|konten|affiliate|afiliate)\b)",
        ],
    ),
    (
        # "Apa ada KPI nya apa ya?" — what gets measured, not what gets
        # promised. Deliberately BELOW TANYA_TARGET: "KPI target sales-nya
        # berapa?" is a request for a committed number, and TANYA_TARGET's
        # refusal is the safer of the two answers.
        #
        # The compound guard is the one TANYA_PAKET_LAMA uses, and for the same
        # reason: gold f11 ("Paket 150 affiliate? tata cara gimana? apa hasil
        # yg di dapatkan? adakah KPI? cost?") asks five things at once, and the
        # KPI clause is not what that message is about. Two or more "?" means
        # the existing routing answers it better than a KPI reply would.
        Intent.TANYA_KPI,
        [
            r"^(?!(?:[^?]*\?){2})(?=.*\bkpi\b)",
            r"\b(indikator|parameter|metrik|matrik\w*)\b.{0,25}"
            r"\b(keberhasilan|sukses|berhasil|performa|campaign|kerja sama)\b",
            r"\b(apa|apa aja|apa saja)\b.{0,20}\byang\b.{0,15}\b(diukur|dinilai)\b",
        ],
    ),
    (
        # The withdrawn 150-affiliate tier. Old decks and ad creatives still
        # circulate — "[Spesial offer] Saya tertarik untuk Paket 150 affiliate"
        # arrived through an ad in the corpus. Above TANYA_HARGA so it is
        # corrected rather than answered with today's ladder as if it matched.
        # The leading lookahead requires the 150 to BE the question, not just
        # appear in it: two or more "?" means a compound enquiry ("Paket 150?
        # tata cara gimana? apa hasil? adakah KPI? cost?", gold f11) where the
        # package is one item among several, and the existing routing answers
        # it better than a package correction would.
        Intent.TANYA_PAKET_LAMA,
        [
            r"^(?!(?:[^?]*\?){2})(?=.*\bpaket\b.{0,12}\b150\b)",
            r"^(?!(?:[^?]*\?){2})(?=.*\b150\b.{0,12}\b(affiliate|afiliate|akun|creator)\b)",
            # The old standalone 500 Affiliate package (Rp75jt) is retired too,
            # but "500 affiliate" is NOT free to claim the way 150 is: the
            # 18 Sep deck sells a live "Special Bundle 500 Affiliate + minimal
            # 500 video" at Rp55jt/6 bulan. So this needs the brand to show
            # they mean the old one — the retired price, or a past-tense
            # marker — and stands down the moment the bundle is named.
            r"^(?!(?:[^?]*\?){2})"
            r"(?!.*\b(bundle|bundling|spesial|special)\b)"
            r"(?=.*\b500\b.{0,12}\b(affiliate|afiliate|akun|creator)\b)"
            r"(?=.*(\b(75|45) ?(juta|jt)\b|\bversi lama\b|\bmasih ada\b|\bdulu\b))",
        ],
    ),
    (
        # "Jd ini meeting brapa orang ka?" / "jika atasan saya berhalangan
        # hadir jika dengan saya apakah tidak masalah?" — logistics of the
        # meeting itself, not a request for one. Above SETUJU so asking who
        # attends is not read as agreeing to a slot.
        Intent.TANYA_MEETING_DETAIL,
        [
            r"\bmeeting\b.{0,20}\b(brp|brapa|berapa|brapaa)\b.{0,10}\borang\b",
            r"\b(brp|brapa|berapa)\b.{0,10}\borang\b.{0,20}\bmeeting\b",
            r"\b(atasan|bos|owner|manaje\w*|direktur|pimpinan)\b.{0,30}"
            r"\b(berhalangan|gak bisa|ga bisa|tidak bisa|gk bisa|absen|hadir)\b",
            r"\bsiapa (aja|saja)\b.{0,20}\b(ikut|hadir|join|meeting)\b",
            r"\bmeeting\w*\b.{0,15}\b(pakai|pake|lewat|via)\b.{0,10}\bapa\b",
            # "Untuk waktunya di jam kerja atau bukan?" — when we meet, as
            # opposed to naming a time (SETUJU). The template now states the
            # hours and ends with the slot ask (24 Sep 2026, inbound/).
            r"\b(waktu|waktunya|jadwal|jadwalnya|meeting|meet)\w*\b.{0,20}"
            r"\b(jam kerja|jam kantor|hari kerja|weekend|akhir pekan|hari libur)\b",
            r"\b(jam kerja|jam kantor)\b.{0,15}\b(atau|apa|ya|kah|aja|bukan)\b",
        ],
    ),
    (
        # "Soalny ka aku jualan baru banget dan bukan brand besar" — a brand
        # ruling ITSELF out. Twice in the corpus and once live, and it is not
        # a discount ask: it deserves reassurance, not a price defence.
        #
        # Deliberately BELOW NEGO_HARGA. "paket umkm ada ga? saya keberatan
        # jika harus bayar 25juta" carries an explicit price objection, and
        # NEGO_HARGA both answers it and escalates to a human, which is the
        # better handling. This catches the version without the objection.
        # Narrow on purpose. A bare "brand baru" is how brands INTRODUCE
        # themselves ("saya punya brand baru | nama : perlyco.id", gold f11)
        # and a bare "umkm" appears inside price objections — an earlier draft
        # matching both cost 5 gold rows. What is left is the self-
        # deprecating form, which is only ever said as an objection.
        Intent.BRAND_KECIL,
        [
            r"\bbukan (brand|toko|usaha|pemain) (besar|gede)\b",
            r"\b(brand|toko|usaha|bisnis|jualan)\w*\b.{0,20}"
            r"\bmasih\s+(kecil|baru|merintis|rintisan|pemula)\b",
            r"\bmasih\s+(kecil|merintis|pemula)\b.{0,20}"
            r"\b(brand|toko|usaha|bisnis|jualan)\w*\b",
            r"\bbaru (banget|bgt)\b.{0,25}\b(jualan|usaha|buka|mulai|merintis)\b",
            r"\bpaket\b.{0,12}\bumkm\b",
            # "Wowww mahal Kak | Mhn maaf belum masuk untk UMKM sprt saya" —
            # not a request for a discount (that is NEGO_HARGA) but a brand
            # saying the offer is not sized for it. REPLY_BRAND_KECIL answers
            # exactly that: we work with brands still building awareness,
            # and here is the package that exists.
            r"\b(belum|blm|gak|ga|tidak|tdk) (masuk|cocok|sanggup)\b.{0,20}\b(umkm|ukm|usaha kecil)\b",
            r"\bumkm\b.{0,20}\b(seperti|sprt|spt|kaya|kayak) (saya|sy|kami)\b",
            # Asking for something below the floor, 24 Sep 2026: "apakah ada
            # paket affiliate yg lebih rendah lagi, untuk percobaan dulu?",
            # "50 dulu bisa gk?", "sebulan awal 5 jt unt 50 affiliator?".
            # Three times in inbound/, and the team's answer is the same
            # each time — the 100 is the floor and there is nothing under it
            # — which is what REPLY_BRAND_KECIL already says. Two-digit
            # counts only: "butuh 2000 affiliate" is TANYA_CUSTOM's.
            r"\b(paket|harga)\w*\b.{0,30}\b(lebih (rendah|kecil|murah)|termurah|terkecil|"
            r"paling (rendah|kecil|murah))\b",
            r"\b(percobaan|trial|uji coba|coba dulu|tes dulu)\b",
            # An ASK for a two-digit count, not a report of one: "kerjasama
            # MCN dgn 50 creator tapi belum ada yg konversi" describes a past
            # campaign (PERNAH_AGENCY), so a request cue has to sit near the
            # number and past-tense cues rule it out.
            r"^(?!.*\b(pernah|udah|sudah|sdh|ud|dgn|dengan|kemarin|kmrn)\b.{0,40}"
            r"\b[1-9]\d\s*(affiliate|afiliate|affliate|affiliator|afiliator|akun|creator|kreator)\b)"
            r".*\b(bisa|bs|boleh|blh|ada|kalau|kalo|klo|minta|mau|ambil|coba)\b[^?.]{0,60}"
            r"\b[1-9]\d\s*(affiliate|afiliate|affliate|affiliator|afiliator|akun|creator|kreator)\b"
            r"(?![^?]*\b(gimana|gmn|kriteria|siapa|follower)\b)",
            r"\b[1-9]\d\s+(dulu|dl|dlu|aja|saja)\b.{0,12}\b(bisa|bs|boleh|blh|ga|gak)\b",
        ],
    ),
    (
        # "kalo by komisi aja bisa ga?" / "apakah bisa by commission only?" —
        # a proposal to drop the campaign fee, which is a different question
        # from how commission works, and the answer is no. Must sit above
        # TANYA_KOMISI, whose bare "komisi" would otherwise take it.
        Intent.TANYA_KOMISI_ONLY,
        [
            r"\b(komisi|commission|cps|bagi ?hasil|profit ?shar\w*)\b"
            r"( \w+){0,2} (aja|saja|only|doang|dulu)\b",
            r"\b(only|cuma|hanya|sekedar|sekadar)( \w+){0,2} "
            r"\b(komisi|commission|cps|bagi ?hasil)\b",
            r"\b(cps|commission|komisi) ?only\b",
            r"\btanpa (biaya|fee|bayar|campaign fee)\b",
        ],
    ),
    (
        Intent.TANYA_KOMISI,
        [
            r"\bkomisi\w*\b",
            r"\bcommission\b",
            r"\b(cps|komisi only|commission only)\b",
            # "%unt affiliator gimana?" — a percentage asked about the
            # affiliates (or us) with no figure and no word "komisi". The
            # answer is the split: the affiliate cut follows the brand's
            # open plan, which REPLY_TANYA_KOMISI states without a number.
            r"\bpersen\b.{0,20}\b(affiliate|afiliate|affiliator|afiliator|creator|kreator|mcn\w*)\b",
            r"\b(affiliate|afiliate|affiliator|afiliator|creator|kreator)\w*\b.{0,20}\bpersen\b",
        ],
    ),
    (
        Intent.TANYA_PEMBAYARAN,
        [
            r"per bulan atau|atau per bulan|per ?bulan (kah|ya|yah|ini)\b.*\?",
            r"\b(dp|down ?payment|termin|cicil\w*)\b",
            r"full ?payment|payment full|bayar\w* (full|di ?awal|dulu|sekali)",
            r"\bppn\b|\bpajak\b",
            r"(pembayaran|payment)( ?nya)?\b.*(gimana|bagaimana|gmn|seperti apa|kapan|berapa kali|brp kali)",
            r"bayar ?nya.*(gimana|gmn|kapan|sekali|per )",
            # "Kecuali bs dibayarkan 2 tahap" — instalments asked for by
            # count. The answer is the one-time-after-invoice term the
            # template already states (24 Sep 2026, inbound/).
            r"\b(bayar|dibayar|dibayarkan|pembayaran|payment)\w*\b.{0,20}"
            r"\b(\d\s*)?(tahap|termin|kali|bertahap|cicil\w*)\b",
        ],
    ),
    (
        # Commission talked about as a bare figure — "12%", "8% itu bkn y?",
        # "12 untuk affiliate, 4 untuk mcn". Reachable only since `_normalise`
        # started preserving percentages; before that "12%" was just "12".
        #
        # Deliberately a SECOND komisi block rather than patterns added to the
        # first: this has to run after TANYA_PEMBAYARAN, or "dp 50%" would
        # read as a commission question instead of a payment-terms one. It
        # still precedes TANYA_HARGA, so "25jt plus 10% compliance fee" lands
        # on the commission rather than the price.
        Intent.TANYA_KOMISI,
        [
            r"\b\d{1,3} persen\b",
        ],
    ),
    (
        Intent.TANYA_TIMELINE,
        [
            r"(berapa|brp) lama.*(proses|jalan|running|eksekusi|mulai|sampai|smp)",
            r"proses\w*.*(berapa|brp) lama",
            r"\btimeline\b",
            r"kapan (mulai|jalan|running|eksekusi|di ?mulai)",
            # Reverse word order too: "better running dari kapan ya kalau
            # kita ambil 300 affilate?"
            r"(running|mulai|jalan) dari kapan",
        ],
    ),
    (
        Intent.TANYA_SAMPLE,
        [
            r"\bsampel\w*\b|\bsample\w*\b|\bsampl\w*\b",
            r"\bgaransi\w*\b",
            r"(kalau|kalo|kl|misal\w*|gimana (kalau|kalo)).*(gak|ga|gk|tidak|tdk|nggak) (bikin|buat|review|upload|post)",
            # "Kalau video affiliate tidak tercapai penaltynya gimana?" (inbound
            # corpus) fell through to TANYA_AFFILIATE and got the curation/list
            # answer. Missing videos are exactly what GUARANTEE covers. Stands
            # down on sales words: a penalty for missed SALES is TANYA_TARGET's
            # "no GMV guarantee", and answering it with the sample guarantee
            # reads as a yes.
            r"^(?!.*\b(penjualan|sales|gmv|omzet|omset|laku|roi)\b)"
            r".*\b(penalt\w*|pinalt\w*|denda|kompensasi)\b",
            r"\b(video|konten|vt)\b.{0,30}\b(gak|ga|gk|tidak|tdk|nggak|belum)\s*"
            r"(tercapai|terpenuhi|capai|nyampe|sampai)\b",
        ],
    ),
    (
        Intent.TANYA_PORTOFOLIO,
        [
            r"portofolio|portfolio|credential|case study|study case|studi kasus",
            r"(contoh|bukti|hasil|report|laporan|data|performa)\w*.*\b(brand|gmv|penjualan|klien|client|campaign)",
            r"\bdashboard\b",
            r"(brand|klien|client) apa (saja|aja)",
            r"(pernah|udah|sudah) (handle|menangani|pegang|jalanin)",
            # "Brand kosmetik apa yg sudah kerja sama dgn kk ya" — the
            # portfolio asked by category; "Contoh2 livenya ada kak?", "boleh
            # minta contoh video yg dibuat affiliate" — examples of the work.
            # Both answered by presenting the portfolio at the meeting, which
            # is what the team did (24 Sep 2026, inbound/).
            r"\b(brand|klien|client)\w* \w+ apa\b.{0,30}\b(kerja ?sama|handle|gabung|bareng|pakai|pake)\b",
            r"\b(brand|klien|client)\w*\b.{0,30}\b(sudah|udah|sdh|pernah|yg|yang)\b.{0,12}\b(kerja ?sama|kerjasama|handle|gabung|bareng)\b",
            r"\bcontoh\w*\b.{0,24}\b(live\w*|video\w*|vt|konten\w*|portofolio|hasil)\b",
            # Case-study drill-down: "untuk varesse revenue dalam jangka
            # waktu setahun ya kak?"
            r"\brevenue\b",
        ],
    ),
    (
        Intent.TANYA_LOKASI,
        [
            r"(kantor|office|alamat|lokasi|posisi|base)( ?nya)?\b.*\b(mana|dmn|dimana)",
            r"(di ?mana|dmn)\b.*(kantor|office|lokasi|alamat)",
            r"(visit|mampir|main|berkunjung|datang|silaturahmi)\w*.*\bkantor",
            r"\bke kantor\b",
            r"penipuan|nipu|scam|tipu",
            # Does-the-office-exist probes. Kept this narrow on purpose: the
            # gold "fee nya brpa ? … Apakah ada kantor nya ??" is TANYA_HARGA,
            # so a bare "(ada|apakah) kantor" would steal it.
            r"\bada kantor ?nya kan\b",  # "tp ini ada kantornya kan ka?"
            r"\bapakah kantor\b",  # "di sidoarjo itu gudang apa ya kak / apakah kantor juga"
            r"\bapakah ada kantor (atau|di)\b",  # "disurabaya apakah ada kantor atau sales?"
            # "Minta sharelock nya kak" — share-lok(asi), asking where we are.
            r"\bshare ?lo(k|c)\w*",
        ],
    ),
    (
        # "Berapa harga unt LS nya kak?", "live streaming nya berapa?" —
        # a PRICE question about live streaming. Above TANYA_LIVE and far
        # above TANYA_HARGA, whose bare "berapa" answered this with the
        # affiliate anchor — the wrong service (24 Sep 2026). "LS" is how
        # the corpus abbreviates it; it is anchored as a whole word next to
        # a price word so it cannot fire inside anything else.
        Intent.TANYA_HARGA_LIVE,
        [
            r"\b(ls|live|livestream\w*|live ?streaming|livestreaming)\b.{0,30}"
            r"\b(harga|harganya|biaya|biayanya|tarif|rate|berapa|brp|paket|price)\b",
            r"\b(harga|harganya|biaya|biayanya|tarif|rate|berapa|brp|paket|price)\w*\b.{0,30}"
            r"\b(ls|live|livestream\w*|live ?streaming|livestreaming)\b",
        ],
    ),
    (
        # Live streaming: a service the company really offers (knowledge.py
        # OFFICE_NOTE) with no answer path before this. Ahead of
        # TANYA_AFFILIATE so "affiliate yg bantu live" reads as the live
        # question it is.
        Intent.TANYA_LIVE,
        [
            r"\blive\b.*\b(jualan|streaming|tiktok|shopee|affiliate|afiliate|akun|brand|account)\b",
            r"\b(bantu|dibantu|sekalian|daily|include|termasuk) ?live\b",
        ],
    ),
    (
        Intent.TANYA_AFFILIATE,
        [
            # The standdown on package/price words is the same lesson the
            # price-list fix taught one paragraph down, arriving by a second
            # route. On 18 Sep 2026 the deck restored the 100/200/300 ladder,
            # and a brand naming a tier writes "paket 200 affiliate berapa?".
            # That is "affiliate" + "berapa", so this alternative claimed it
            # and answered the highest-intent message we get with "list
            # affiliate baru kami bagikan setelah kita deal" — a refusal to a
            # question about price. With one package nobody phrased it this
            # way, which is why the rule survived until the ladder came back.
            # Count questions are NOT price questions and keep their answer
            # here: "paket 100 affiliate isinya berapa orang?" is the tail.
            r"^(?!.*\b(harga|biaya|tarif|fee|price ?list|pricelist)\b)"
            # And the shape that carries no price word at all: a tier named,
            # then a bare "berapa" at the end. Bounded deliberately — the
            # golden "Paket 150 affiliate Mcnasia.biz? tata cara gimana? apa
            # hasil yg di dapatkan? adakah KPI? cost?" also says "paket", and
            # it is an affiliate question with a price question stapled on,
            # answered as such by the real agent. "berapa" must be what the
            # sentence ENDS on for this to be a price question.
            r"(?!.*\b(paket|bundle|bundling)\b[^?]{0,20}\b(berapa|brp)\b"
            r"(\s+(ya|yah|kak|kaka|ka|kk|dong|sih|nih))*\s*\??\s*$)"
            # And the same shape with no package word at all — "500 affiliate
            # berapa?" is a tier and a price question, nothing else.
            r"(?!.*\b(100|200|300|500)\s*(affiliate|afiliate|akun|video|creator|kreator)\b"
            r"[^?]{0,12}\b(berapa|brp)\b"
            r"(\s+(ya|yah|kak|kaka|ka|kk|dong|sih|nih))*\s*\??\s*$)"
            # `.*?` after the anchored standdown: `^(?!…)` fixes the position,
            # so without it the affiliate noun would have to be the first word.
            r".*?(affiliate|afiliate|affliat|kreator|creator)\w*.*"
            r"(kriteria|seperti apa|kaya (apa|gimana|gmn)|siapa|follower|niche|kategori"
            r"|gimana|gmn|berapa|brp|kapan|estimasi)",
            r"(kriteria|list|daftar|follower|niche|views?)\w*.*(affiliate|afiliate|creator|kreator)",
            r"video\w*.*(per|tiap|masing)\w*.*(affiliate|afiliate|creator|kreator)",
            # "tiktok dl atau Shopee dl" — the platforms need not be adjacent.
            r"(di )?(tiktok|shopee)( \w+){0,2} (atau|apa) (tiktok|shopee)",
            # English inquiries (the NORDES-style RFP).
            r"\bcreator (pool|sourcing|availability)\b",
            # `rate ?cards?` left here on 24 Sep 2026: "ada rate card atau
            # company profile?" is a request for the document (MINTA_PROFILE),
            # and this answered it with the curation criteria.
            # "bisa minta datanya 150 org itu kak?", "nama2 afiliatornya
            # siapa aja dan mau kami lihat performancenya", "bisa milih
            # listnya?" — 4 turns in inbound/, all UNKNOWN before this.
            # REPLY_TANYA_AFFILIATE already answers them in the team's own
            # words ("list affiliate baru kami bagikan setelah deal"), so
            # what was missing was only the recognition.
            #
            # The affiliate noun is REQUIRED, and price words are excluded.
            # The first version of this rule asked only for a request verb
            # plus a "data/list" word, which made "boleh minta price list nya
            # kak?" an affiliate question — the highest-intent inbound
            # message there is, answered with "we don't share the list before
            # a deal". `\d+ org` counts as the noun: "datanya 150 org itu"
            # is asking about the affiliates without naming them.
            r"^(?!.*\b(harga|price ?list|pricelist|biaya|rate ?card|budget)\b)"
            r"(?=.*\b(affiliate|afiliate|afiliator|affiliator|creator|kreator|\d+ ?(org|orang))\w*\b)"
            r"(?=.*\b(data|datanya|list|listnya|daftar|performance|performa\w*)\b)"
            r"(?=.*\b(minta|lihat|liat|lht|cek|kirim|milih|pilih|siapa)\w*\b)",
            r"\bnama ?\d?\w*\b.{0,16}\b(afiliator|affiliator|affiliate|afiliate|creator)\w*\b.{0,24}\bsiapa\b",
            r"\b(bisa|boleh|bs)\b.{0,12}\b(milih|pilih|memilih)\b.{0,12}\b(list|listnya|affiliate|afiliate|creator)\b",
        ],
    ),
    (
        # "brand saya elektronik kak apakah bisa?" — a brand naming its
        # category and asking whether we can take it on. A buying signal that
        # dead-ended twice in live testing, and two dead ends in a row is the
        # handover threshold. Ranked after TANYA_AFFILIATE so creator
        # questions keep their own answer, and before TANYA_HARGA so the
        # greedy "berapa" rule cannot swallow it.
        Intent.TANYA_KECOCOKAN,
        [
            # A possessive is the signal: this is about *their* brand, not
            # the word "toko" appearing anywhere. Without it, "Jika Shopee nya
            # sudah punya toko tinggal jalani aja sistem kalian" — a
            # how-does-it-work question — lands here.
            # saya/kami only — "nya" is "the/its", not "my", and "Shopee nya sudah
            # punya toko" is a how-does-it-work question, not a fit question.
            r"\b(brand|produk|toko|usaha|bisnis|kategori)\w* ?(saya|sy|kami|aku|ku)\b"
            r"(?:(?!\bjam\b).)*\b(bisa|bs|cocok|masuk|handle|terima|available)\b",
            # Adjacent-ish: an unbounded .* matched a "bisa" in one sentence
            # against a "handle" three sentences later.
            r"\b(bisa|bs|boleh|blh)( \w+){0,2} handle\b",
            r"\bcocok (gak|ga|ngga|nggak|tidak|tdk|g)\b",
            # Will it work for us? — asked about their own product, without
            # ever using the word "bisa".
            r"\bngefek\b",
            r"\b(tetep|tetap) (bs|bisa|jalan)\b",
            r"\b(emang|emg) laku\b",
            r"\blaku (ga|gak|ya|nggak)\b",
            r"\b(bs|bisa) (ga|gak) sih\b",
            # "ga" here must be the question particle, not the "ga" in "ga tau"
            r"\bmasuk (ga|gak|ngga|nggak|kah)\b(?!\s+(tau|tahu|ngerti|paham|jelas|yakin))",
            r"\b(handle|tangani)\w*( \w+){0,2} (jg|juga)( \w+){0,2} (ga|gak|kah|ngga)\b(?!\s+(tau|tahu|ngerti|paham|jelas|yakin))",
            r"\b(relevan|works|cocok|sesuai)( \w+){0,2} (ga|gak|ngga|nggak|kah)\b(?!\s+(tau|tahu|ngerti|paham|jelas|yakin))",
            r"\bke(kecil|besar|mahal|murah)an\b",
            # The other word order, seen live: the question comes first and
            # the category after it. Anchored on the question mark so a bare
            # "bisa" plus a stray "brand" later is not enough.
            r"\b(bisa|bs|cocok|handle|terima)\b[^?]*\?.*"
            r"\b(brand|produk|kategori|toko|usaha)\w* ?(saya|sy|kami|aku|ku)\b",
        ],
    ),
    (
        # "kalau by request apakah bisa? seperti custom gitu" — asking whether
        # the packages bend. Ahead of TANYA_HARGA, whose paket rules would
        # otherwise answer with the price ladder instead of the question.
        Intent.TANYA_CUSTOM,
        [
            # \bcustom\w* also matches "customer": "lg ngurusin customer dl"
            # was reading as a package-customisation question.
            r"\bcustom(is\w*|ize\w*|)\b(?!er)",
            r"\bby request\b",
            r"\bpaket\w*\b.*\b(disesuaikan|sesuaikan|khusus|fleksibel)\b",
            r"\b(bisa|bs|boleh|blh)\b.*\b(disesuaikan|dicustom|request)\b",
            # Asking for a shape the three packages do not have.
            r"\bopsi lain\b",
            r"\b(bs|bisa|boleh)\b.*\b(digabung|dipotong|diatur|dipecah|dicicil|mix)\b",
            r"\btanpa \w+.*\bpaket\w*\b",
            r"\bdiluar \d+ paket\b",
            # A volume the two tiers do not cover: "butuh 2000 affiliate".
            r"\b(butuh|membutuhkan|mau|pengen|perlu|minta|request)\b[^?]*"
            r"\b\d{3,4}\s*(affiliate|afiliate|affliate|creator|kreator)\b",
            r"\b\d{3,4}\s*(affiliate|afiliate|affliate|creator|kreator)\b[^?]*"
            r"\b(possible|bisa|bs|kah|ga|gak)\b",
            r"\b(campaign|request|order)\b[^?]*\b\d{3,4}\b",
            r"\b(cuma|cm|hanya) (mau|butuh|perlu)\b.*\b(bisa|bs|ada)\b",
        ],
    ),
    # --- inbound, second mining round (24 Sep 2026) ------------------------
    # Three more shapes from inbound/, each the moment the CRM PDF says to
    # "gali kebutuhan → offer", each UNKNOWN before this — which answered a
    # warm lead with "boleh dijelaskan sedikit lebih detail maksud Kakak?".
    (
        # "Aku ragu neh karena ud 2x pernah dipromosiin tapi gak ada hasil",
        # "affiliate video banyak tapi gak ke arah sales", "kerjasama MCN
        # dgn 50 creator … blm ada yg konversi". A burned brand, and the
        # objection the team handles best. Every pattern needs BOTH the past
        # attempt and the no-result tail: "pernah handle brand apa?" is a
        # portfolio question, and "hasilnya kurang" on its own is the soft
        # decline TOLAK_HALUS already owns.
        Intent.PERNAH_AGENCY,
        [
            r"\b(pernah|udah|sudah|ud|sdh|pnh)\b.{0,30}"
            r"\b(agency|agensi|mcn|vendor|dipromosi\w*|promosi\w*|affiliate|afiliate|"
            r"campaign|kerja ?sama)\w*\b.{0,40}"
            r"\b(gak|ga|nggak|tidak|tdk|blm|belum|g) (ada )?(hasil|hasilnya|konversi|"
            r"ngefek|efek|jalan|sales|penjualan)\b",
            r"\b(affiliate|afiliate|video|konten|creator|kreator)\w*\b.{0,30}\b(banyak|byk)\b"
            r".{0,30}\b(tapi|tp|tpi|namun|cuma|tetapi)\b.{0,30}"
            r"\b(gak|ga|nggak|tidak|tdk|blm|belum|g)\b.{0,12}"
            r"\b(sales|penjualan|konversi|hasil|ke arah)\b",
            r"\b(kecewa|trauma|kapok|ragu)\b.{0,40}\b(agency|agensi|mcn|vendor|"
            r"affiliate|afiliate|campaign|promosi)\w*",
            r"\b(blm|belum|gak|ga|tidak) ada (yg |yang )?(konversi|hasil)\w*\b"
            r"(?![^.?]*\b(budget|rencana|plan)\b)",
        ],
    ),
    (
        # "Bentuk layanannya apa aja", "Layanan apa saja yang ada di sana",
        # "Kalau slain affiliate apakah ada layanan lainnya", "solusi apa
        # saja" — asking for the menu. Above TANYA_SISTEM, whose generic
        # "(layanan|service) … apa" rule used to take these and answer with
        # how the affiliate campaign works; the corpus answer is the six-line
        # service list plus a question about category and need.
        #
        # No bare "bantu apa": "dr mcnasia bisa bantu apa saja?" is a
        # how-can-you-help question the gold set files as TANYA_SISTEM.
        Intent.TANYA_LAYANAN,
        [
            r"\b(bentuk|jenis|macam|pilihan|opsi|daftar|list) (layanan|service|servis|jasa)\w*",
            r"\b(layanan|service|servis|jasa)\w*( \w+){0,3} (apa (aja|saja|sj)|ada apa)\b",
            r"\b(layanan|service|servis|jasa|program|solusi)\w* (lain|lainnya|lainya|yg lain|yang lain)\b",
            r"\b(selain|slain|sln) (affiliate|afiliate|affliate|itu|ini)\b.*\b(ada|apa|punya)\b",
            r"\bsolusi apa (aja|saja|sj)\b",
            r"^(ada|punya) apa (aja|saja|sj)( (ya|yah|kak|kaa|ka|kk|nih|dong|sih))*\s*\??$",
            r"\b(menyediakan|nyediain|menawarkan|nawarin|provide|tawarkan|sediakan)\w*"
            r"( \w+){0,3} (layanan|service|servis|jasa|program)\w*",
            # "Ada program optimalisasi toko shopee ga kk" — a service asked
            # for by description. The menu names it (Marketplace Management)
            # and the reply asks what they need, which is the right next step.
            r"\b(program|layanan|service|servis|jasa) (optimasi|optimalisasi|kelola|pengelolaan|manage)\w*",
        ],
    ),
    (
        # "Affiliate", "Afiliate saja", "Saya butuh affiliate kak", "Colab
        # affiliator", "Kebutuhan nya Cari pasukan affiliate kk", "kami ingin
        # bangun team affiliator" — the need, stated. Ten conversations in
        # inbound/ contain this turn, usually answering our own "kebutuhannya
        # apa?", and every one of them was UNKNOWN.
        #
        # Ranked BELOW the questions about affiliates (TANYA_AFFILIATE,
        # TANYA_KECOCOKAN, TANYA_CUSTOM) so "cari affiliate yang followers nya
        # diatas 10k" and "butuh 2000 affiliate" keep their specific answers,
        # and ABOVE TANYA_HARGA with a price-word standdown, so "butuh
        # affiliate, harganya berapa?" is still a price question. "banget/bgt"
        # is excluded because "butuh banget agency affliate" is filed as
        # SETUJU in the gold set (explicit appetite), and that stays.
        Intent.BUTUH_AFFILIATE,
        [
            # The whole message is the need, with at most a few framing words
            # around it: "affliate ka", "untuk campaign affiliate sama
            # livestream", "sedang mencari affiliator".
            r"^((saya|sy|kami|kita|aku|ak|iya|iyah|ya|oke|ok|baik|betul|untuk|utk|"
            r"yang|yg|mau|ingin|pengen|pengin|butuh|perlu|kebutuhan|kebutuhannya|nya|"
            r"colab|kolab|kolaborasi|cari|nyari|mencari|sedang|sdg|lagi|lg|bangun|"
            r"bikin|buat|pasukan|tim|team|akun|jasa|service|layanan|campaign|program|"
            r"ambil|pakai|pake|coba|tertarik|minat|ke|di|sama) )*"
            r"(affiliate|afiliate|affliate|afiliasi|affiliator|afiliator|affliator|"
            r"affiliatenya|afiliatenya)\w*"
            r"( (aja|saja|dulu|dl|dlu|ya|yah|kak|kaa|ka|kk|nya|dong|deh|sih|dan|sama|"
            r"livestream|live|ads|konten|nih))*\s*$",
            # A need verb within a few words of the noun: "Saya butuh
            # affiliate kak", "kami ingin bangun team affiliator".
            r"^(?!.*\b(harga|biaya|berapa|brp|fee|budget|price|pricelist|banget|bgt|"
            r"follower|followers|kriteria|list|data|siapa)\b)"
            r".*\b(butuh|perlu|cari|nyari|mencari|bangun|colab|kolab|kolaborasi|"
            r"tertarik|minat|ingin|pengen)\w*( \w+){0,3} "
            r"\b(affiliate|afiliate|affliate|affiliator|afiliator|affliator)\w*",
            # "Hijab. Kebutuhan campaign affiliate, sama livestream" and
            # "Affiliate. Jubah pria - fashion muslim" — the need with the
            # category beside it, sometimes a second service too. The team
            # answered both with the affiliate pitch and the invitation
            # (24 Sep 2026, inbound/). Two shapes: "kebutuhan … affiliate"
            # anywhere, and the affiliate noun as the FIRST word followed
            # by a short description — with a standdown for the words that
            # turn it into a question or a report ("affiliate kami sudah ada
            # tim", "affiliate nya level berapa").
            r"^(?!.*\b(harga|biaya|berapa|brp|fee|budget|price|list|data|kriteria|"
            r"follower|siapa|level|lv)\b)"
            r".*\bkebutuhan\w*\b.{0,30}\b(affiliate|afiliate|affliate|affiliator|afiliator)\w*",
            r"^(affiliate|afiliate|affliate|affiliator|afiliator)\w*"
            r"(?!.*\b(sudah|udah|sdh|ada|gak|ga|nggak|tidak|tdk|belum|blm|berapa|brp|"
            r"harga|biaya|kami|saya|kita|kalian|siapa|gimana|gmn|bisa|bs|list|data|"
            r"kriteria|follower|level|lv|nya|itu|yang|yg)\b)"
            r"(?!.*\?)( \w+){1,8}$",
            # "Hallo kaa untuk affiliate apakah bisa kah" — can you do this
            # for me. The pitch-plus-invitation is the answer.
            r"^(?!.*\b(harga|biaya|berapa|brp|fee|budget|price)\b)"
            r".*\b(untuk|utk) (campaign |program |service |layanan )?"
            r"(affiliate|afiliate|affliate)\w*( \w+){0,2} (apakah |apa )?(bisa|bs|ada)\b",
        ],
    ),
    # --- questions ---------------------------------------------------------
    (
        Intent.TANYA_HARGA,
        [
            # Code-switching is normal here: "untuk pricenya start di
            # nominal yang sama kak?" was reaching the LLM every time.
            r"\b(price|pricing|pricelist|rate ?card)(nya|ny)?\b",
            r"\b(harga|harganya|biaya|biayanya|tarif|rate|budget|cost|fee)\b",
            # Naming one of the packages and asking about it is a package
            # question, whatever the question word. "untuk 500 affiliate
            # detailnya bagaimana" read as TANYA_SISTEM and got the generic
            # "we curate creators" answer, with the 500 never mentioned.
            # Every tier the brand may name, not just the two that existed
            # when this rule was written: the 18 Sep deck ladder is
            # 100/200/300, and 500 stays because the Special Bundle prices it
            # and retired decks are still in brands' hands.
            r"\b(100|200|300|500)\s*(affiliate|afiliate|afiliasi|creator|paket)\b",
            r"\bpaket\b( \w+){0,2} \b(detail|rincian|isinya|dapat|dapet)\w*\b",
            # "jam berapa/brp" is a scheduling question, not a price one — the
            # lookbehind keeps it out of the price bucket (gold-set finding).
            r"(?<!jam )\bber(a)?pa\b",
            r"(?<!jam )\bbrp\b",
            r"price ?list",
            # "pl" is how the team and the brands both write price list —
            # "untuk plnya apakah bisa didiskusikan". Checked against the
            # 356 real client turns: it never appears as anything else.
            r"\bpl\s*(nya)?\b",
            # Package questions in either word order: "detail paketnya",
            # "paket detailnya", "ada paket apa aja", "opsi paketnya".
            r"\b(detail|rincian|rinci|list|opsi|pilihan|macam|jenis)\w*\b.*\bpaket",
            r"\bpaket\w*\b.*\b(berapa|brp|harga|detail|rincian|apa|aja|saja|mana)",
            r"\bpaket\w*\s*(nya)?\s*(dong|dulu|ya|kak|ka)?\s*\??$",
            # "paket yg sesuai yg fokus ke peningkatan penjualan" — naming
            # a goal and asking which package serves it. The rules above
            # all want a question word beside "paket", and this has none.
            r"\bpaket\w*\b.*\b(sesuai|cocok|pas|fokus|rekomendasi|saran|butuh)\w*\b",
            r"\b(sesuai|cocok|rekomendasi|saran)\w*\b.*\bpaket\w*\b",
        ],
    ),
    (
        Intent.TANYA_SISTEM,
        [
            r"penawaran[^.?!]{0,20}dalam bentuk apa\b",
            r"\bkerja ?sama ?(nya)? (seperti apa|dalam bentuk apa|gimana)\b",
            r"\b(sistem|sistemnya|cara ?kerja|mekanisme|skema|prosesnya)\b",
            # gmna joins gmn/gimana: "Gmna nih kak cara nya ?". No \w* on
            # gimana — the gold set keeps "ky gimananya" musings UNKNOWN.
            r"(gimana|bagaimana|gmn|gmna|bgmn)\b",
            r"maksudnya (apa|gimana)",
            r"jelas ?(kan|in|kn)",  # "Kak blh jelas kn dlu gak ini tuh sprti ap"
            r"detail(nya)? (apa|gimana|seperti apa)",
            # "Campaign affiliate itu spt apa?", "sprti ap gambaran kerja
            # sama nya" — final a optional for the second spelling.
            r"\b(seperti|spt|sprti) apa?\b",
            r"apa itu",
            # "ini apa ya ka", "ini tentang apa ya kak" — the first thing a
            # stranger says to a cold message, and it used to burn a strike.
            # Anchored to the end through a short filler tail so that
            # "ini apa bedanya paket A dan B?" keeps falling to the price
            # bucket rather than being answered as "what is this".
            r"\bini (apa|apaan|tentang apa|maksudnya)"
            r"(\s+(ya|yah|kak|kaka|ka|kk|sih|nih|dong|kok|itu))*\s*\??$",
            # "Bisakah saya mendapatkan info selengkapnya tentang ini?"
            r"\binfo (selengkap|lengkap)\w*",
            # "kamu menyediakan kasa apa aja ya?" — "kasa" is a typo for
            # "jasa", too short for the repair threshold. The verb carries
            # the question, so the noun does not have to be spelled right.
            r"\b(menyediakan|menyediain|nyediain|menawarkan|nawarin|provide)\w*\b"
            r".*\bapa\b",
            r"\b(jasa|layanan|servis|service)\w*\b.*\b(apa|aja|saja|mana)\b",
            # "Campaign affiliate meliputi apa ka" — what is in it. The
            # system answer (curation, sample, content, daily monitoring) is
            # exactly the list they are asking for.
            r"\b(meliputi|mencakup)\b.*\bapa\b",
        ],
    ),
    (
        # "Mau info affiliate", "Kak mau tanya service MCNASIA", "Info kak",
        # "boleh minta info lebih lanjut tentang affiliate ini?" — the vague,
        # warm ask that every worked script in the CRM PDF opens with. Not a
        # question about anything yet, so the answer is the one-breath
        # explanation and a question back (product? which platform?), never
        # a price and never a meeting push — the PDF's "gali kebutuhan".
        #
        # Below every specific question, so "mau tanya harganya" stays a
        # price question and "info selengkapnya" keeps its TANYA_SISTEM gold
        # label. Above SETUJU because "boleh minta info lebih lanjut" was
        # being read as consent off the bare "boleh" — and consent at
        # Node.NEW skips the qualification form and proposes meeting slots to
        # someone who only asked what we do.
        #
        # The standdown keeps two neighbours out: "nanti kami infokan ya"
        # (NANTI_AJA, ranked lower) is a promise, not a request; and "boleh
        # info jadwal meeting yang tersedia" is scheduling.
        Intent.MINTA_INFO,
        [
            r"^(?!.*\b(nanti|akan|infokan|infoin|kabari|kabarin|update|jadwal|meeting|"
            r"meet|slot|link|email|alamat|kontrak|rekening|nomor|no)\b)"
            r".*\b(minta|mau|boleh|bisa|butuh|pengen|ingin|mohon|ada|bisakah|bolehkah)"
            r" (di)?(info|informasi|penjelasan|dijelaskan|penjelasannya)\w*",
            r"^(?!.*\b(nanti|akan|infokan|kabari|kabarin)\b)"
            r".*\b(info|informasi) (lebih )?(lanjut|lengkap|detail|lengkapnya|detailnya)\b",
            # "Info kak", "info dong", a bare "info".
            r"^((halo|hai|hallo|pagi|siang|sore|malam|kak|ka|kk|min) )*"
            r"(info|infonya|informasi)"
            r"( (kak|ka|kk|min|dong|donk|nya|ya|yah|lengkapnya|detailnya|please|pls))*\s*\??$",
            # "Kak mau tanya service MCNASIA", "mau tanya tentang kerjasama
            # di Mcn ini", "saya mau konsultasi" (the taplink opener).
            # "tanya" only, not "tau": "kalo boleh tau dr mcnasia bisa bantu
            # apa saja?" is a how-can-you-help question the gold set files
            # as TANYA_SISTEM.
            r"\b(mau|ingin|pengen|boleh|bisa|izin|ijin|mo) (tanya|nanya|bertanya)\w*"
            r"( \w+){0,3} \b(service|servis|layanan|jasa|kerja ?sama\w*|kolaborasi|program|"
            r"mcn\w*|affiliate|afiliate|affliate|penawaran)\b",
            r"\b(mau|ingin|pengen|boleh|bisa|izin|ijin) konsultasi\b",
            # "tertarik sama programnya, bisa info?"
            r"\b(tertarik|minat|berminat)\b( \w+){0,4} \b(bisa|boleh|minta|mau) "
            r"(info|dijelaskan|penjelasan|tau|tahu)\w*",
        ],
    ),
    # --- acceptance --------------------------------------------------------
    (
        Intent.SETUJU,
        [
            # "boleh" is agreement ("boleh kak", "bolehh") but ALSO the polite
            # opener of a permission question ("boleh kami pilih sendiri
            # affiliatenya?", "videonya boleh kami repost ga?"). Both of those
            # were read as consent and answered with "saya siapkan jadwalnya"
            # — booking a meeting off a question about content rights.
            #
            # A pronoun or "di-" straight after it marks the permission form:
            # nobody agrees by saying "boleh kami". Requests that name what
            # they want ("boleh minta kontraknya") are already claimed by the
            # rules above this one.
            r"\bboleh+\b(?!\s*(kami|kita|aku|saya|di|nya|ga|gak|nggak|tidak)\b)",
            r"\b(bisa|oke|ok|baik|siap)\b.*\b(meeting|meet|jadwal|diskusi|zoom)\b",
            r"\b(meeting|meet|jadwal|diskusi)\b.*\b(boleh|bisa|oke|ok|silakan|silahkan)\b",
            r"kapan (bisa|available|meeting)",
            r"jam berapa",
            r"atur (jadwal|meeting)",
            r"\bgmeet\b",  # picking the medium is accepting: "Gmeet saja / Besok"
            r"\b(ayo|ayuk)\b",  # "Jadi ka / Ayuk ka"
            r"\brencana\w* kapan\b",  # "Rencanannya kapan kak?"
            # Explicit appetite: "Ak emg butuh banget agency affliate  kak".
            r"\b(butuh|perlu) (banget|bgt)\b",
            # Email handoff for the invite: "[email] berikut yaa kak untuk
            # email nyaaa" (replay masks addresses to [email]; "berikut"
            # keeps bare context-only emails in UNKNOWN, per the gold set).
            r"^email\b.*\bberikut\b",
        ],
    ),
    (
        Intent.TERIMA_KASIH,
        [
            r"^(terima ?kasih|makasih|mksh|thanks|thank you|tq|trims)\b",
            r"^sama[- ]?sama\b",
            r"terima ?kasih (atas|untuk) (penawaran|infonya|info)",
            # The spellings the anchored rule above misses, anywhere in a
            # short message. Guarded against "thank you FOR the reminder",
            # which the gold set reads as an acknowledgement, not a sign-off.
            r"^(?!(ok|oke|okay|okey|baik|sip|siap|noted|well noted)\b)"
            r".*\b(tq|thx|tks|nuhun|matur ?nuwun|suwun)\b",
            r"^(?!(ok|oke|okay|okey|baik|sip|siap|noted|well noted)\b)"
            # "terimaksih" — one letter short, and it defeated every spelling
            # above, so "sore ka, terimaksih atas penawaran nya" fell through
            # to REPLY_FREEFORM and asked a brand who had just thanked us to
            # explain what they meant.
            r".*\b(makasi+h?|mkasih|maaci+h?|terima?ka?si+h?|trim[as]+)\b"
            r"(?!.*\b(atas|untuk|buat) (reminder|remindernya|update|updatenya|konfirmasi)\b)",
            r"^(?!(ok|oke|okay|okey|baik|sip|siap|noted|well noted)\b)"
            r".*\bthank ?(you|s)( a lot| bgt| banget)?\b(?!\s*(for|atas|untuk))",
            # A well-wish is a sign-off whatever precedes it, so these carry no
            # leading-word guard. "baik kak good luck yaa" was read as
            # OK_LANJUT on 14 Aug — the "baik kak" won — and the flow answered
            # a farewell with three meeting slots.
            r"\bgood ?luck\b",
            r"\bsemoga (sukses|lancar|berhasil|terus berkembang)\b",
            r"\bsukses (selalu|terus|ya|yaa)\b",
        ],
    ),
    (
        Intent.NANTI_AJA,
        [
            r"nanti (aja|saja|dulu|ya)",
            r"belum (sempat|bisa|ada waktu)",
            r"lagi (sibuk|busy|banyak)",
            r"(minggu|bulan) depan\b(?![^?]*\?)|next (week|month)\b(?![^?]*\?)",
            r"kabari (lagi|nanti)",
            # "Bsa kak , cmn klo bsk ak msh padat kak jdwal ku huhu" — the
            # gold set reads this as a deferral, not a booking.
            r"\b(masih|msh) padat\b",
            # "Saya lg gak di jakarta / Nanti plg saya info lg ya".
            r"\bnanti (\w+ )?(saya|sy|sya|aku|kita|kami) (info|kabar|berkabar)",
            # Deferrals pinned to a moment rather than the word "nanti".
            r"\btar (aja|dulu|dl)\b",
            r"\b(abis|setelah|habis) (lebaran|ramadhan|puasa|natal|raya)\b",
            # Only a deferral when nothing is being asked. "minggu depan
            # apakah bisa?" proposes a slot and belongs in SETUJU.
            r"\bnext (quarter|month|week|bulan|tahun)\b(?![^?]*\?)",
            r"\bhold (dl|dulu|dlu)\b",
            # "Nanti aku wa", "nanti KLO ud ok aku wa ya" — they will come
            # back on their own initiative. Distinct from TUNGGU ("bentar
            # saya cek"), which is a pause inside this conversation.
            r"\bnanti\b.{0,20}\b(aku|saya|sy|sya|kami|kita)\b.{0,8}\b(wa|whatsapp|chat|hubungi|kontak)\b",
            # "Aku masih d luar neh", "saya masih di jalan", "Maaf ini masih
            # ada kerjaan" — busy right now, no request in it.
            r"\bmasih\b.{0,8}\b(di|d) ?(luar|jalan|kantor klien|meeting)\b",
            r"\bmasih ada (kerjaan|kerjaaan|urusan|meeting)\b",
            r"\b(lagi|lg|sedang|sdg) (di ?)?(jalan|luar|meeting)\b(?![^?]*\?)",
            r"\b(skrg|sekarang)\b.*\b(blm|belum) (bs|bisa) gerak\b",
            r"\blg hectic\b",
            r"\bkuartal (depan|berikutnya)\b",
            # "Sorry mbak hari ini aku keluar" — out today, so not today.
            r"\b(lg|lagi|hari ini|hr ini) (\w+ )?(keluar|di ?luar)\b",
        ],
    ),
    # --- the answer to our own focus question (24 Sep 2026) ----------------
    (
        # "Lebih ke sales kak", "dua-duanya kak", "pengen naikin awareness",
        # "fokus ke penjualan dulu". Four templates end by asking "fokus
        # campaign lebih ke awareness, penjualan, atau keduanya?" and the
        # rules could not read the answer: "lebih ke sales" was UNKNOWN (a
        # strike towards handover, for answering us) and "dua-duanya" was
        # OK_LANJUT (a slot list, skipping the need).
        #
        # Whole-message and short by construction: a focus word plus framing
        # particles, no question mark, nothing else. "sales kami sudah ada
        # tim" and "target sales nya berapa?" do not match. What the rule
        # cannot know is whether we ASKED — "sales" can be an answer to
        # something else — so `Engine` keeps this label only when the last
        # message we sent asked for the focus (`asks_for_focus`), and drops
        # it to UNKNOWN otherwise. `focus_of` reads which answer it was.
        Intent.FOKUS_CAMPAIGN,
        [
            r"^(?!.*\?)"
            r"(?:(?:" + _FOCUS_FILLER + r")\s+)*"
            r"(?:" + _FOCUS_WORD + r")"
            r"(?:\s+(?:" + _FOCUS_FILLER + r"|" + _FOCUS_WORD + r"))*\s*$",
        ],
    ),
    # --- generic acknowledgement, LAST: "ok"/"baik" prefix almost anything --
    (
        Intent.OK_LANJUT,
        [
            r"^(ok|oke|okay|baik|siap|sip|yes|ya|iya|betul)\b",
            r"^(ok|oke|baik|siap)[ ,.!]*(kak|ka|bang|bu|pak|sis)?$",
            # Doubled-letter acks the elongation collapse (3+ only) misses:
            # "Sipp", "okaay kak", "baikk kak", "iyaa kakk thankyou yaa".
            # Question-free only — gold reads "okaay baik kak / jika atasan
            # saya berhalangan … apakah tidak masalah?" as UNKNOWN.
            r"^(o+k+e*y*|o+k+a+y+|baik+|sip+|siap+|iya+|ya+)\b[^?]*$",
            r"^oh (baik|ok|oke|gt|gitu)\b",  # "Oh baik kak", "Oh gt. Ok baik ka"
            r"\bnoted\b",  # "Noted kak", "well noted see youu yaa!"
            # Gratitude with an object is an ack, not the polite brush-off
            # TERIMA_KASIH models: "thank you for the confirmation ya!",
            # "thankyou untuk reminder nya ya kakk".
            r"thank ?you (for|atas|untuk)",
            r"^(gpp|gapapa|ga papa|gak papa)\b",  # "Gpp"
            # The two "keduanya" / "awareness|sales" patterns that used to
            # sit here moved to FOKUS_CAMPAIGN on 24 Sep 2026: they were the
            # answer to our own focus question, and OK_LANJUT proposed
            # meeting slots off them instead of acknowledging the need.
            # Abbreviated capability-yes opener: "Bs ka / Nanti ksh link ke
            # aku y" — the gold set files it as ok_lanjut, not SETUJU. Only
            # this clipped form: a lone "Bisa" and "bisa kak tlg …" requests
            # stay UNKNOWN (golden 0803 transcript, gold set).
            r"^(bs|bsa) ka\b",
            r"silakan|silahkan",
            r"boleh (di)?lanjut",
        ],
    ),
]

_COMPILED: list[tuple[Intent, list[re.Pattern[str]]]] = [
    (intent, [re.compile(p) for p in patterns]) for intent, patterns in _RULES
]


#: The figure in a commission counter-offer, so the reply can quote it back.
#: "5 %" / "5persen" / "7,5%" all render as "5%" / "7,5%".
_OFFERED_PERCENT_RE = re.compile(
    r"\b(\d{1,2}(?:[.,]\d+)?)\s*(?:%|persen)", re.IGNORECASE
)


def offered_percent(text: str) -> str:
    """The commission figure a brand just proposed, or "" if there is none.

    Repeating a brand's own number back is not the bot stating a rate — it is
    acknowledging theirs before management rules on it. That is why
    REPLY_NEGO_KOMISI is static: the figure comes from the brand's message,
    never from the model.
    """
    m = _OFFERED_PERCENT_RE.search(_normalise(text))
    return f"{m.group(1)}%" if m else ""


def question_topics(text: str) -> list[Intent]:
    """The distinct subjects a message ASKS about, in order.

    Two or more means the brand asked about different things at once, and any
    single reply necessarily leaves part of it unanswered — the flow escalates
    so a human sees what the bot did not cover.

    Both halves of the test earn their place. Question marks alone are not
    enough: "bisa quick meet jam berapaaa? jam 2 apakah aman?" is two
    questions about one subject. Distinct intents alone are not enough
    either — splitting on newlines made every multi-line *statement* look
    compound ("sorry wait ya / nanti kita berkabar" scored TUNGGU + NANTI_AJA),
    which put the rate at 13% of all turns.
    """
    if text.count("?") < 2:
        return []
    topics: list[Intent] = []
    for part in text.split("?"):
        part = part.strip()
        if len(part) < 6:
            continue
        got = classify_rules(part)
        if got is not Intent.UNKNOWN and got not in topics:
            topics.append(got)
    return topics


def classify_rules(text: str) -> Intent:
    """Rule-based classification. Returns UNKNOWN when nothing matches."""
    norm = _normalise(text)
    if not norm:
        return Intent.UNKNOWN
    for intent, patterns in _COMPILED:
        if any(p.search(norm) for p in patterns):
            return intent
    return Intent.UNKNOWN


_LLM_SYSTEM = """You classify replies from Indonesian brand representatives to a \
B2B affiliate-marketing sales outreach on WhatsApp.

Reply with exactly one label from this list, nothing else:

setuju           - agrees to a meeting, or asks when/what time to meet
ok_lanjut        - short agreement/acknowledgement to proceed
tanya_sistem     - asks how the service or system works
tanya_harga      - asks about price, packages, or budget
tanya_portofolio - asks for portfolio, credentials, case studies, GMV proof, dashboards
tanya_lokasi     - asks where the office is, wants to visit, or doubts legitimacy
tanya_komisi     - asks how commissions work (brand/MCN split, CPS, commission-only)
tanya_pembayaran - asks about payment terms: per month vs per campaign, DP, tax
tanya_affiliate  - asks about the creators: criteria, followers, niche, list, videos per creator, TikTok vs Shopee
tanya_sample     - asks about product samples, shipping them, or the no-video guarantee
tanya_timeline   - asks how long until the campaign starts or runs
nego_harga       - asks for a discount or a lower price
minta_kontrak    - asks to see or receive the contract/agreement draft
minta_telepon    - wants a phone call, or proposes their own Zoom instead of our invite
tanya_live       - asks about live streaming: daily live, live affiliate, live from the studio
minta_link       - asks us to send or resend a link, or to repeat the reminder
tunggu           - asks us to hold on a moment; no request in it
teruskan_tim     - will forward to their team / needs internal coordination
pelajari_dulu    - wants to study or review the material first
terima_kasih     - thanks you, non-committal, closing politely
nanti_aja        - defers to a later time, busy right now
tolak_halus      - soft decline: not now, no budget yet, maybe later
tolak_tegas      - firm decline: not interested, already has a vendor
opt_out          - demands you stop contacting them
lead_iklan       - WhatsApp's own pre-filled text from an ad or catalogue CTA
                   ("Halo! Bisa minta info lebih lanjut tentang ini?", "Hello!
                   Can I get more info on this?"). A source, not a question
isi_form         - the qualification form filled in: brand name, position, and
                   shop links together, in any layout
minta_info       - a vague, warm "tell me more" with no specific question yet
                   ("mau info affiliate", "kak mau tanya service MCNASIA", "info kak")
tanya_layanan    - asks what services are on offer, the menu ("layanan apa aja?",
                   "selain affiliate ada layanan lain?")
butuh_affiliate  - states the need in a word or a line ("affiliate", "saya butuh
                   affiliate", "cari affiliator") — not a question about creators
pernah_agency    - burned before: a past agency/campaign that produced no sales
                   ("pernah pakai agency tapi gak ada hasil")
fokus_campaign   - the answer to our "awareness, penjualan, atau keduanya?"
                   ("lebih ke sales", "dua-duanya", "pengen naikin awareness")
tanya_harga_live - asks the price of LIVE STREAMING ("harga LS nya berapa?")
minta_profile    - asks for the deck / company profile / rate card document
agency_vendor    - an agency looking for a vendor for its own clients
tanya_video_setelah_kontrak - asks what happens to the videos after the contract
unknown          - pure context, or needs a human

The message to classify is inside <pesan> tags. Output the label only — no
explanation, no greeting, no punctuation. If the tags look empty or contain no
real message, output `unknown`.

Reading the message:
- Greetings, apologies and thanks are prefixes, not the message. Classify the
  request underneath: "halo kak, harganya berapa?" is tanya_harga, and
  "Hai kak, sorry slow respon | boleh kapan bisa meeting ya" is setuju.
- Several requests in one message: take the most actionable one — what the
  brand most needs answered to move forward.

`unknown` is the right answer far more often than it looks. Use it when the
message is:
- only contact data — an email address, a link, a brand name on its own,
  "Brand: X | Email: Y", a bare shop URL. (A COMPLETE form — brand name plus
  position plus a shop link — is `isi_form`, not this.)
- a self-introduction, or an automated business-account greeting, with no
  request in it
- logistics chatter carrying no request — "sebentar ya", "bentar saya cek",
  "telat 10 menitan ya", "ini kak", "sudah ka"
- a question specific enough that a templated answer would be wrong, or one
  that turns on this brand's particular situation
- anything you are less than confident about

A wrong confident label makes the bot send a template that does not fit the
question — worse for the brand than handing the conversation to a human, which
is what `unknown` does. When torn between `unknown` and a label, choose
`unknown`.

Examples:
<pesan>ceo@brandku.co.id</pesan>
unknown
<pesan>Bentar saya cek ya</pesan>
unknown
<pesan>• Nama Brand: wilica
• Posisi di Brand: pemilik</pesan>
unknown
<pesan>halo kaa, kalau jam 2 bisa ga ya? jam 10 uda ada agenda</pesan>
setuju
<pesan>hallo kak, terima kasih ya sudah reach out ke kita. so far kita belum ada budget untuk ini</pesan>
tolak_halus
<pesan>halo siang kak
ini kantornya dimana? apakah bisa visit kantor?</pesan>
tanya_lokasi"""

_VALID = {i.value for i in Intent}


def _first_label(raw: str) -> str:
    """The label out of a model reply, or "" if there is not exactly one.

    Tolerates the wrappers a chat model reaches for — backticks, a trailing
    full stop, a `label: ` prefix — without tolerating prose. A sentence that
    happens to contain a label name is not a classification, so anything with
    more than one recognised label, or with words around it, is rejected and
    handled as an unrecognised reply.
    """
    cleaned = re.sub(r"[^a-z_\s]", " ", raw.strip().lower())
    words = [w for w in cleaned.split() if w]
    found = [w for w in words if w in _VALID]
    if len(found) == 1 and len(words) <= 2:
        return found[0]
    return ""


def classify_llm(text: str, cfg: Settings) -> Intent:
    """Claude fallback. Returns UNKNOWN on any error — never raises."""
    if not cfg.anthropic_api_key:
        return Intent.UNKNOWN
    try:
        import anthropic
    except ImportError:
        log.warning("anthropic package not installed; skipping LLM classification")
        return Intent.UNKNOWN

    try:
        client = anthropic.Anthropic(api_key=cfg.anthropic_api_key)
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=16,
            system=_LLM_SYSTEM,
            # Wrapped, never bare: a turn whose whole content is an email
            # address or a URL reads as an empty prompt, and the model answers
            # the system prompt conversationally ("I'm ready to classify…")
            # instead of emitting a label. The tags make it unmistakably data.
            messages=[{"role": "user", "content": f"<pesan>\n{text[:2000]}\n</pesan>"}],
        )
        label = _first_label(resp.content[0].text)
        if label:
            return Intent(label)
        log.warning("LLM returned unrecognised label %r", resp.content[0].text[:80])
    except Exception:
        log.exception("LLM intent classification failed")
    return Intent.UNKNOWN


#: Intents the Claude fallback is allowed to decide on its own.
#:
#: Measured on the 240-turn gold set, the fallback *lowers* accuracy — it
#: answers with a confident label where the correct output is `unknown`, and
#: the labels it invents are overwhelmingly the decisive ones: OK_LANJUT,
#: SETUJU, PELAJARI_DULU, NANTI_AJA. Those change what happens next — a wrong
#: SETUJU proposes slots and books, a wrong TOLAK_TEGAS ends the conversation,
#: a wrong NANTI_AJA parks a live lead on a follow-up ladder.
#:
#: The questions are different: answering a price question that was really
#: about commissions sends slightly-off information and the brand simply asks
#: again. So the fallback may guess at *what was asked*, and may not decide
#: whether the deal moves, stalls, or dies — anything decisive it cannot place
#: falls to UNKNOWN, which is the escalation path a human already watches.
_LLM_DECIDABLE: frozenset[Intent] = frozenset(
    {
        # Neither of the two inbound intents decides anything: LEAD_IKLAN at
        # Node.NEW sends the qualification form, which is what an UNKNOWN
        # there would have sent anyway, and ISI_FORM sends the service
        # summary. No booking, no rejection, no follow-up ladder — they pass
        # the test above. Without them here the fallback could return the
        # label, have it thrown away, and bill for the call.
        Intent.LEAD_IKLAN,
        Intent.ISI_FORM,
        # The 24 Sep inbound trio pass the same test: each is answered with
        # an explanation or the menu and, at most, an invitation the brand
        # still has to accept. None books, rejects, or parks a lead.
        Intent.MINTA_INFO,
        Intent.TANYA_LAYANAN,
        Intent.BUTUH_AFFILIATE,
        Intent.PERNAH_AGENCY,
        Intent.FOKUS_CAMPAIGN,
        Intent.TANYA_HARGA_LIVE,
        Intent.MINTA_PROFILE,
        Intent.AGENCY_VENDOR,
        Intent.TANYA_VIDEO_SETELAH_KONTRAK,
        Intent.TANYA_SISTEM,
        Intent.TANYA_HARGA,
        Intent.TANYA_PORTOFOLIO,
        Intent.TANYA_LOKASI,
        Intent.TANYA_KOMISI,
        Intent.TANYA_PEMBAYARAN,
        Intent.TANYA_AFFILIATE,
        Intent.TANYA_SAMPLE,
        Intent.TANYA_TIMELINE,
        Intent.MINTA_KONTRAK,
        Intent.NEGO_HARGA,
        Intent.TANYA_LIVE,
        Intent.MINTA_LINK,
        # Refusals. A stop request is never worth second-guessing, and the
        # two declines belong here for the same reason: backing off from a
        # brand who was still interested costs a follow-up they can restart,
        # while missing a refusal means continuing to sell to someone who
        # said no.
        Intent.OPT_OUT,
        Intent.TOLAK_HALUS,
        Intent.TOLAK_TEGAS,
    }
)


#: Domain words worth repairing a typo in. Kept small and specific on
#: purpose — a general spell-checker over Indonesian chat shorthand would do
#: more harm than good, since half of what brands type is a deliberate
#: abbreviation the rules already understand.
_VOCABULARY = frozenset(
    """affiliate afiliate elektronik komisi harga meeting jadwal kontrak sample
    portofolio portfolio kategori produk brand campaign creator kreator budget
    paket pembayaran kantor lokasi timeline proposal invoice diskon negosiasi
    marketplace tiktok shopee dashboard reminder""".split()
)


def _despell(norm: str) -> str:
    """Repair obvious typos in domain words. Returns the text unchanged when
    nothing is close enough.

    Conservative by construction: only tokens of six characters or more, only
    a single best match, and only when the token is not already a word we
    know. "elektrokin" becomes "elektronik"; "bs", "gk" and the rest of the
    shorthand are left exactly as they are, because the rules are written
    against that shorthand.
    """
    import difflib

    out, changed = [], False
    for token in norm.split():
        if len(token) < 6 or token in _VOCABULARY:
            out.append(token)
            continue
        match = difflib.get_close_matches(token, _VOCABULARY, n=1, cutoff=0.86)
        out.append(match[0] if match else token)
        changed = changed or bool(match)
    return " ".join(out) if changed else norm


#: Messages that are UNKNOWN and always will be — asking Claude about them
#: buys nothing. A bare greeting, a bare address, a bare link: the flow
#: handles each identically to any other unplaced turn, so the only thing a
#: call would add is the bill. Found by replaying every stored inbound on
#: 14 Aug 2026, when a fifth of all messages were still reaching the LLM.
_NO_LLM = [
    # "hallo kak," / "selamat siang kak" / "hai kak grace" — an opener with
    # nothing in it yet.
    r"^(selamat )?(h[ae]l+o+|hai|hi|hy|pagi|siang|sore|malam)"
    r"[\s,!.]*(kak|ka|kk|sis|bang|pak|bu|min)?[\s,!.]*(grace|mcn\w*)?[\s,!.]*$",
    # `_normalise` already collapses an address to "email" and a URL to
    # "link", so a message that is only one of those normalises to just that.
    # The flow lifts the real address out of the raw text separately.
    r"^(email|link)$",
    # Emoji or punctuation only — normalises to nothing at all.
    r"^$",
    # A bare pointer word sent on its own, usually just before or after the
    # message it refers to: "ini", "nih", "ok ini". There is no intent in it
    # to find, and one of these cost a call on 14 Aug 2026.
    r"^(ok(e|ay)?[\s,.]*)?(ini|nih|itu|tuh)[\s,.!]*$",
]
_NO_LLM_RE = [re.compile(p, re.I) for p in _NO_LLM]


def classify(text: str, cfg: Settings) -> Intent:
    """Rules first; Claude only for what the rules can't place."""
    intent = classify_rules(text)

    # Second pass on a typo-repaired copy. Deliberately only after a miss, so
    # a correction can rescue an unmatched turn but can never re-route one the
    # rules already placed. "brand saya elektrokin kak apakah bisa?" is the
    # live example.
    if intent is Intent.UNKNOWN:
        repaired = _despell(_normalise(text))
        if repaired != _normalise(text):
            guess = classify_rules(repaired)
            if guess is not Intent.UNKNOWN:
                log.info("typo repair placed %r as %s", text[:50], guess.value)
                intent = guess

    if intent is not Intent.UNKNOWN or not cfg.use_llm_intents:
        return intent

    # Unplaceable by anyone. Skip the call rather than pay for the same
    # UNKNOWN we already have.
    probe = _normalise(text)
    if any(p.match(probe) for p in _NO_LLM_RE):
        log.debug("no-LLM shortcut for %r", text[:40])
        return Intent.UNKNOWN

    guess = classify_llm(text, cfg)
    if guess in _LLM_DECIDABLE:
        return guess
    if guess is not Intent.UNKNOWN:
        log.info(
            "LLM guessed %s for an unmatched turn; too decisive to accept, "
            "leaving it to a human",
            guess.value,
        )
    return Intent.UNKNOWN
