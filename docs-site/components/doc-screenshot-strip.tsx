import { productScreenshots } from "@/content/screenshots";
import { assetPath } from "@/lib/site";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function DocScreenshotStrip({ screenshotIds }: { screenshotIds?: string[] }) {
  const screenshots = productScreenshots.filter((shot) =>
    screenshotIds?.includes(shot.id)
  );

  if (screenshots.length === 0) {
    return null;
  }

  return (
    <div className="mt-8 grid gap-4 md:grid-cols-2">
      {screenshots.map((shot) => (
        <Card key={shot.id} className="overflow-hidden py-0">
          <img
            src={assetPath(shot.src)}
            alt={shot.alt}
            className="aspect-video w-full border-b object-cover"
          />
          <CardHeader>
            <CardTitle className="text-base">{shot.title}</CardTitle>
          </CardHeader>
          <CardContent className="pb-5 text-sm text-muted-foreground">
            {shot.caption}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
