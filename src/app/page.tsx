import Link from "next/link";
import { getCurrentUser } from "@/lib/fanvue";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const me = await getCurrentUser();
  const isAuthed = !!me;
  const params = await searchParams;
  const errorDescription =
    typeof params?.error_description === "string"
      ? params.error_description
      : typeof params?.error === "string"
        ? params.error
        : undefined;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">
            Live
          </h1>
          <p className="text-sm text-[var(--muted)]">
            Sign in to start a live session.
          </p>
        </div>

        {isAuthed ? (
          <div className="flex flex-col gap-3">
            <Link
              href="/call"
              className="rounded-full bg-[var(--accent)] px-4 py-3 text-center text-sm font-semibold text-[var(--accent-contrast)]"
            >
              Go live
            </Link>
            <form action="/api/oauth/logout" method="post">
              <button
                type="submit"
                className="w-full rounded-full border border-[var(--border)] px-4 py-3 text-sm font-medium text-[var(--foreground)]"
              >
                Log out
              </button>
            </form>
          </div>
        ) : (
          <a
            href="/api/oauth/login"
            target="_top"
            className="rounded-full bg-[var(--accent)] px-4 py-3 text-center text-sm font-semibold text-[var(--accent-contrast)]"
          >
            Log in with Fanvue
          </a>
        )}

        {!isAuthed && errorDescription ? (
          <p className="text-sm text-[var(--danger)]">{errorDescription}</p>
        ) : null}
      </div>
    </div>
  );
}
