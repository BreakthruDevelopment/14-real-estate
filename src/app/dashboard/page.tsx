import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro, Panel, buttonSecondary } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const roleLabel = { user: "Buyer", agent: "Agent", admin: "Admin" } as const;

/** Placeholder until the UI slices (14.7 to 14.9) add the agent, account and admin pages. */
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  return (
    <>
      <PageIntro section="Dashboard" title={`Hi, ${user.name}`} description={`Signed in as ${user.email}. Role: ${roleLabel[user.role]}.`} />
      <Panel title="Your account">
        <p className="mb-3 break-words text-muted">
          {user.role === "agent"
            ? "You can create and manage listings through the agent API. The editor arrives with the agent pages."
            : user.role === "admin"
              ? "Admins see counts and moderate listings. Grant the agent role from the admin page."
              : "Browse listings, save favorites and write to an agent. An admin grants the agent role."}
        </p>
        {user.role === "admin" ? (
          <Link href="/admin" className={buttonSecondary}>
            Admin
          </Link>
        ) : null}
      </Panel>
    </>
  );
}
