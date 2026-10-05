import { LinkCheckDetail } from "@/components/link-check-detail";

export default async function LinkCheckDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LinkCheckDetail key={id} checkId={id} />;
}
