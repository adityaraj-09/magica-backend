import { requireUser } from "@/server/auth/require-user";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();

  return (
    <main>
      <h1>Galaxy Agent API</h1>
      <p>
        Signed in as {user.email}. Balance {user.creditBalance.toString()} credits.
      </p>
    </main>
  );
}
