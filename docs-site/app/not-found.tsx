import { Button } from "@/components/ui/button";
import { SiteShell } from "@/components/site-shell";
import { withBasePath } from "@/lib/site";

export default function NotFound() {
  return (
    <SiteShell>
    <main className="mx-auto w-full max-w-4xl px-4 py-20 md:px-8">
      <h1 className="font-heading text-4xl tracking-tight md:text-5xl">Page not found.</h1>
      <p className="mt-4 text-muted-foreground">
        We couldn’t find that page. It may have moved, or the link may be incorrect.
      </p>
      <Button className="mt-8" asChild>
        <a href={withBasePath("/")}>Back to home</a>
      </Button>
    </main>
    </SiteShell>
  );
}
