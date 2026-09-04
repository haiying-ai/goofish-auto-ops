import {
  createConfiguredXianyuSession,
  XianyuAuthenticationError,
} from "../../../../lib/xianyu-session";
import { uploadListingImage } from "../../../../lib/xianyu-items";
import { requireOwnerAccess } from "../../../../lib/access";

export const dynamic = "force-dynamic";

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/heic",
]);

export async function POST(request: Request) {
  const denied = await requireOwnerAccess(request);
  if (denied) return denied;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "请选择商品图片" }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return Response.json(
        { error: "仅支持 PNG、JPG、WEBP 或 HEIC 图片" },
        { status: 400 },
      );
    }
    if (file.size < 1 || file.size > 5 * 1024 * 1024) {
      return Response.json(
        { error: "图片大小必须在 5MB 以内" },
        { status: 400 },
      );
    }
    const session = await createConfiguredXianyuSession();
    const image = await uploadListingImage(session, file, file.name);
    return Response.json({ success: true, image });
  } catch (error) {
    const authRequired = error instanceof XianyuAuthenticationError;
    return Response.json(
      {
        error: error instanceof Error ? error.message : "图片上传失败",
        code: authRequired ? "AUTH_REQUIRED" : "UPLOAD_FAILED",
      },
      { status: authRequired ? 401 : 502 },
    );
  }
}
