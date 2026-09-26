"""Guards on settings whose wrong value fails silently.

A path that points at nothing is the worst kind of defect here: the send
still happens, the transcript still looks right, and the only trace is one
log line nobody reads. The 18 Sep 2026 deck swap left ADS_DECK_PDF naming
the archived August filename, so every brand who asked about ads got the
prices as text and no deck, for as long as it took to notice.
"""

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _declared_ads_deck() -> list[tuple[str, str]]:
    """The ads deck as each place spells it: the dataclass default, and the
    two env files. All three must name the same file, or a deploy picks up
    whichever one happens to win."""
    src = (ROOT / "src" / "bd_bot" / "config.py").read_text(encoding="utf-8")
    default = src.split('"ADS_DECK_PDF",', 1)[1].split('"', 2)[1]
    out = [("(default)", default)]
    for name in (".env", ".env.example"):
        f = ROOT / name
        if not f.is_file():
            continue
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.startswith("ADS_DECK_PDF="):
                out.append((name, line.split("=", 1)[1].strip()))
    return out


@pytest.mark.skipif(
    not (ROOT / "opening").is_dir(),
    reason="business assets are not in the public repo",
)
@pytest.mark.parametrize("where,value", _declared_ads_deck())
def test_the_ads_deck_names_a_file_that_exists(where, value):
    assert (ROOT / value).is_file(), (
        f"ADS_DECK_PDF in {where} names {value!r}, which is not there. "
        "_send_ads_deck logs a warning and sends the ads answer with no "
        "attachment — nothing else in the system will tell you."
    )


def test_every_place_that_names_the_ads_deck_agrees():
    values = {v for _, v in _declared_ads_deck()}
    assert len(values) == 1, f"ADS_DECK_PDF disagrees across sources: {values}"


@pytest.mark.skipif(
    not (ROOT / "opening").is_dir(),
    reason="business assets are not in the public repo",
)
def test_the_opening_folder_holds_exactly_one_deck():
    """Everything in opening/ is sent to every brand. A second PDF left here
    by a swap means two decks land back to back, and the retired one is
    indistinguishable from the current one in the chat."""
    pdfs = sorted(p.name for p in (ROOT / "opening").glob("*.pdf"))
    assert len(pdfs) == 1, f"opening/ holds {len(pdfs)} PDFs: {pdfs}"


@pytest.mark.skipif(
    not (ROOT / "opening").is_dir(),
    reason="business assets are not in the public repo",
)
def test_the_ads_deck_is_the_deck_the_opening_sends():
    """Not a rule of nature — they were different files before 18 Aug 2026 —
    but while they are the same, `_attach` suppresses the repeat for a brand
    who already has it. If this ever fails on purpose, delete it.

    Deliberately compares the DECLARED strings rather than calling
    config.load(): load() does os.environ.setdefault() for every line of the
    real .env, so a test that calls it leaves the developer's own settings
    set for every test that runs afterwards. Written here the obvious way
    first, it turned three unrelated tests red under random ordering.
    """
    opening = sorted(p.name for p in (ROOT / "opening").glob("*.pdf"))
    for where, value in _declared_ads_deck():
        assert Path(value).name == opening[0], (
            f"ADS_DECK_PDF in {where} is not the deck in opening/"
        )
