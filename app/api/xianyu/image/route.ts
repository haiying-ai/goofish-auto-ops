export const dynamic = "force-dynamic";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0 Safari/537.36";

export async function GET(request: Request) {
  const value = new URL(request.url).searchParams.get("url") || "";
  const candidates = imageCandidates(value);
  if (!candidates.length) {
    return Response.json({ error: "商品图片地址无效" }, { status: 400 });
  }

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: {
          accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          referer: "https://www.goofish.com/",
          "user-agent": USER_AGENT,
        },
      });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.startsWith("image/")) continue;
      return new Response(response.body, {
        headers: {
          "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
          "content-type": contentType,
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      // Try the next equivalent Alibaba CDN path.
    }
  }

  return Response.json({ error: "商品图片暂时无法读取" }, { status: 502 });
}

function imageCandidates(value: string) {
  const raw = value.trim();
  if (!raw) return [];
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    if (!isAllowedHost(url.hostname)) return [];
    url.protocol = "https:";
    const candidates: string[] = [];
    const alternate = new URL(url);
    if (alternate.pathname.startsWith("/imgextra/")) {
      alternate.pathname = alternate.pathname.replace(
        "/imgextra/",
        "/bao/uploaded/",
      );
      // The upload endpoint sometimes serves a 200 response containing only a
      // solid-color placeholder on /imgextra/. The canonical listing path is
      // the image Xianyu stores in item details, so try it first.
      candidates.push(alternate.toString(), url.toString());
    } else if (alternate.pathname.startsWith("/bao/uploaded/")) {
      candidates.push(url.toString());
      alternate.pathname = alternate.pathname.replace(
        "/bao/uploaded/",
        "/imgextra/",
      );
      candidates.push(alternate.toString());
    } else {
      candidates.push(url.toString());
    }
    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

function isAllowedHost(hostname: string) {
  const host = hostname.toLowerCase();
  return (
    host === "alicdn.com" ||
    host.endsWith(".alicdn.com") ||
    host === "goofish.com" ||
    host.endsWith(".goofish.com")
  );
}
