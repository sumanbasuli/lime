import { notFound } from "next/navigation";
import { MaterialSymbol } from "@/components/material-symbol";
import { getAllDocPages, getDocPage } from "@/lib/docs";
import { withBasePath } from "@/lib/site";

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
  const allPages = getAllDocPages();
  const pageIndex = allPages.findIndex((candidate) => candidate.href === page.href);
  const previousPage = pageIndex > 0 ? allPages[pageIndex - 1] : null;
  const nextPage = pageIndex >= 0 && pageIndex < allPages.length - 1 ? allPages[pageIndex + 1] : null;

  return (
    <main className="mx-auto grid w-full max-w-[1180px] gap-10 px-5 py-10 sm:px-7 lg:px-10 lg:py-14 xl:grid-cols-[minmax(0,820px)_220px] xl:gap-14">
      <article className="min-w-0">
        <div className="mb-5 inline-flex rounded-full border border-black/15 bg-white px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-black/58">
          {page.category ?? "Reference"}
        </div>
        <div
          className="docs-prose"
          dangerouslySetInnerHTML={{ __html: page.html }}
        />
        <nav className="mt-14 grid gap-3 border-t border-black/10 pt-6 sm:grid-cols-2" aria-label="Adjacent documentation">
          {previousPage ? (
            <a href={withBasePath(previousPage.href)} className="group rounded-xl border border-black/10 bg-white p-4 text-black no-underline hover:border-black/25">
              <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-black/40">
                <MaterialSymbol name="arrow_back" size={14} /> Previous
              </span>
              <span className="mt-2 block font-heading text-lg font-semibold group-hover:underline group-hover:decoration-[#FFED00]">{previousPage.title}</span>
            </a>
          ) : <span />}
          {nextPage ? (
            <a href={withBasePath(nextPage.href)} className="group rounded-xl border border-black/10 bg-white p-4 text-right text-black no-underline hover:border-black/25">
              <span className="flex items-center justify-end gap-1 font-mono text-[9px] uppercase tracking-wider text-black/40">
                Next <MaterialSymbol name="arrow_forward" size={14} />
              </span>
              <span className="mt-2 block font-heading text-lg font-semibold group-hover:underline group-hover:decoration-[#FFED00]">{nextPage.title}</span>
            </a>
          ) : null}
        </nav>
      </article>

      <aside className="hidden xl:block">
        <div className="sticky top-[150px] space-y-8">
          <nav className="border-l border-black/10 py-1 pl-4" aria-label="On this page">
            <div className="mb-2 px-2 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-black/42">
              On this page
            </div>
            {headings.length ? (
              <div className="space-y-0.5">
                {headings.map((heading) => (
                  <a
                    key={heading.id}
                    href={`#${heading.id}`}
                    className={[
                      "block rounded-md px-2 py-1 text-[11px] leading-5 text-black/50 no-underline transition-colors hover:text-black",
                      heading.level > 2 ? "ml-3 text-[10px]" : "",
                    ].join(" ")}
                  >
                    {heading.title}
                  </a>
                ))}
              </div>
            ) : null}
          </nav>

          {page.sourceFiles?.length ? (
            <section
              className="border-l-2 border-[#FFED00] py-1 pl-4"
              aria-label="Source references"
            >
              <div className="mb-2 px-2 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-black">
                Source references
              </div>
              <div className="space-y-1">
                {page.sourceFiles.map((source) => (
                  <a
                    key={source}
                    href={`https://github.com/sumanbasuli/lime/tree/main/${source}`}
                    className="block break-words rounded-md px-2 py-1 font-mono text-[10px] leading-4 text-black/45 no-underline transition-colors hover:text-black"
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
