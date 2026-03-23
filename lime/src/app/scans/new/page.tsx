import { NewScanForm } from "@/components/new-scan-form";

export default function NewScanPage() {
  return (
    <div className="space-y-4">
      <h1 className="font-heading text-3xl font-bold leading-[0.95] sm:text-4xl">
        New scan
      </h1>

      <section className="rounded-xl border bg-card p-4">
        <NewScanForm />
      </section>
    </div>
  );
}
