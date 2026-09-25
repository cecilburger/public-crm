import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/api';
import { getSession } from '@/lib/session';
import { withBase } from '@/lib/basePath';

/**
 * A thin passthrough to the API's generate route. The download needs to be a
 * plain browser navigation (an `<a href>`, not a fetch a component controls),
 * so it can't carry a `Bearer` header itself — this route attaches the
 * session's token server-side and streams the generated .docx straight back.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { accessToken } = await getSession();
  if (!accessToken) return NextResponse.redirect(new URL(withBase('/masuk'), req.url));

  const res = await fetch(`${API_URL}/v1/documents/${id}/generate`, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  if (!res.ok || !res.body) return new NextResponse(null, { status: res.status });

  return new NextResponse(res.body, {
    status: 200,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
      'content-disposition': res.headers.get('content-disposition') ?? 'attachment',
    },
  });
}
