import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Network } from "lucide-react";
import { useEffect, useState } from "react";
import { describeError } from "@/api";
import { authClient, googleRefused } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { session } from "@/session";

/** Google sign-in comes back here with `ott` (a one-time token) or `error`. */
interface LoginSearch {
  readonly ott?: string;
  readonly error?: string;
}

const Login = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { ott, error: googleError } = Route.useSearch();
  const providers = useQuery({
    queryKey: ["sign-in-providers"],
    queryFn: authClient.providers,
    refetchInterval: false,
  });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [googleFailed, setGoogleFailed] = useState(googleError !== undefined);
  const shown = error ?? (googleFailed ? googleRefused(providers.data?.googleDomains ?? []) : null);
  const [pending, setPending] = useState(ott !== undefined);

  const enter = async (token: string) => {
    session.save(token);
    queryClient.clear();
    await navigate({ to: "/", replace: true });
  };

  useEffect(() => {
    if (ott === undefined) return;
    authClient
      .exchange(ott)
      .then((token) => {
        if (token) return enter(token);
        setError("That Google sign-in expired. Try again.");
      })
      .catch((e: Error) => setError(describeError(e)))
      .finally(() => setPending(false));
  }, [ott]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    setGoogleFailed(false);
    try {
      const token = await authClient.signIn(email.trim(), password);
      if (token) await enter(token);
      else setError("That email and password don't match.");
    } catch (e) {
      setError(describeError(e as Error));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex h-svh flex-col items-center justify-center gap-8 bg-background p-6">
      <span className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Network className="size-4" />
        </span>
        <span className="text-base font-semibold tracking-tight">project-os</span>
      </span>
      <Card className="w-full max-w-sm shadow-card [--card-spacing:--spacing(7)]">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Sign in</CardTitle>
          <CardDescription>The dashboard is for operators of this Coordinator.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {providers.data?.google && (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => window.location.assign(authClient.googleStartUrl)}
              >
                Continue with Google
              </Button>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <Separator className="flex-1" />
                or
                <Separator className="flex-1" />
              </div>
            </>
          )}
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {shown && (
              <p role="alert" className="text-sm text-destructive">
                {shown}
              </p>
            )}
            <Button type="submit" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    ...(typeof search.ott === "string" && { ott: search.ott }),
    ...(typeof search.error === "string" && { error: search.error }),
  }),
  component: Login,
});
