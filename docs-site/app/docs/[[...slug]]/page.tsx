import { notFound } from "next/navigation";
import { getAllDocPages, getDocPage } from "@/lib/docs";

interface DocsPageProps {
  params: Promise<{ slug?: string[] }>;
}

interface PageHeading {
  id: string;
  level: number;
  title: string;
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function stripTags(value: string) {
  return decodeHtml(value.replace(/<[^>]*>/g, "").trim());
}

function getPageHeadings(html: string): PageHeading[] {
  return [...html.matchAll(/<h([2-4]) id="([^"]+)">([\s\S]*?)<\/h\1>/g)]
    .map((match) => ({
      level: Number(match[1]),
      id: match[2],
      title: stripTags(match[3]),
    }))
    .filter((heading) => heading.title);
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

  if (!page) {
    notFound();
  }

  const headings = getPageHeadings(page.html);

  return (
    <main className="mx-auto grid w-full max-w-[88rem] gap-10 px-4 py-8 md:px-8 md:py-10 xl:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_380px]">
      <article className="min-w-0 px-1 md:px-2 xl:pr-4">
        <div
          className="docs-prose"
          dangerouslySetInnerHTML={{ __html: page.html }}
        />
      </article>

      <aside className="hidden xl:block">
        <div className="sticky top-24 space-y-8">
          <nav className="border-l border-border/90 py-1 pl-4" aria-label="On this page">
            <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              On this page
            </div>
            {headings.length ? (
              <div className="space-y-0.5">
                {headings.map((heading) => (
                  <a
                    key={heading.id}
                    href={`#${heading.id}`}
                    className={`block rounded-md px-2 py-1 text-xs leading-5 text-muted-foreground no-underline transition-colors hover:text-foreground ${
                      heading.level > 2 ? "ml-3 text-[11px]" : ""
                    }`}
                  >
                    {heading.title}
                  </a>
                ))}
              </div>
            ) : null}
          </nav>

          {page.sourceFiles?.length ? (
            <section
              className="border-l border-[#FFED00] py-1 pl-4"
              aria-label="Source references"
            >
              <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-foreground">
                Source references
              </div>
              <div className="space-y-1">
                {page.sourceFiles.map((source) => (
                  <a
                    key={source}
                    href={`https://github.com/sumanbasuli/lime/tree/main/${source}`}
                    className="block break-words rounded-md px-2 py-1 font-mono text-[11px] leading-4 text-muted-foreground no-underline transition-colors hover:text-foreground"
                  >
                    {source}
                  </a>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </aside>
    </main>
  );
}
