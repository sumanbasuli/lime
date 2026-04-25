import { FileCodeIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { getAllDocPages, getDocPage } from "@/lib/docs";
import { withBasePath } from "@/lib/site";

interface DocsPageProps {
  params: Promise<{ slug?: string[] }>;
}

export const dynamicParams = false;

export function generateStaticParams() {
  return getAllDocPages().map((page) => ({
    slug: page.slug,
  }));
}

export async function generateMetadata({ params }: DocsPageProps) {
  const { slug = [] } = await params;
  const page = getDocPage(slug);
  return {
    title: page?.title ?? "Docs",
    description: page?.excerpt || "LIME documentation",
  };
}

export default async function DocsPage({ params }: DocsPageProps) {
  const { slug = [] } = await params;
  const page = getDocPage(slug);
  const docs = getAllDocPages();

  if (!page) {
    notFound();
  }

  const related = docs
    .filter((doc) => doc.category === page.category && doc.href !== page.href)
    .slice(0, 4);

  return (
    <main className="mx-auto grid w-full max-w-7xl gap-8 px-4 py-8 md:px-8 xl:grid-cols-[minmax(0,1fr)_280px]">
      <article>
        <Card>
          <CardContent className="p-6 md:p-10">
            <div
              className="docs-prose"
              dangerouslySetInnerHTML={{ __html: page.html }}
            />
          </CardContent>
        </Card>
      </article>

      <aside className="space-y-4">
        {page.sourceFiles?.length ? (
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center gap-2 font-heading text-lg font-bold">
                <FileCodeIcon className="size-4" />
                Source references
              </div>
              <Separator className="my-4" />
              <div className="space-y-2">
                {page.sourceFiles.map((source) => (
                  <a
                    key={source}
                    href={`https://github.com/sumanbasuli/lime/tree/main/${source}`}
                    className="block rounded-lg bg-muted px-3 py-2 font-mono text-xs text-muted-foreground no-underline hover:text-foreground"
                  >
                    {source}
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : null}

        {related.length ? (
          <Card>
            <CardContent className="p-5">
              <div className="font-heading text-lg font-bold">Related docs</div>
              <Separator className="my-4" />
              <div className="space-y-2">
                {related.map((doc) => (
                  <a
                    key={doc.href}
                    href={withBasePath(doc.href)}
                    className="block rounded-lg px-3 py-2 text-sm text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground"
                  >
                    <span className="block font-medium text-foreground">{doc.title}</span>
                    <span className="mt-1 line-clamp-2 block text-xs">{doc.excerpt}</span>
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : null}
      </aside>
    </main>
  );
}
