import { requireRole } from "@/lib/auth/session";
import { setUserRole } from "@/lib/auth/roles";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/roles : body `{ userId, role: "user" | "agent" }`. The only way a role changes. Revoking `agent`
 * hides that agent's active and pending listings in the same transaction; granting it again unhides only those.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("admin");
    return Response.json(await setUserRole(user, await readJson(request)));
  } catch (err) {
    return errorResponse(err);
  }
}
