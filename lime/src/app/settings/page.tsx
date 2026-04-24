import { DashboardSettingsForm } from "@/components/dashboard-settings-form";
import { getReportSettings } from "@/lib/report-settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const reportSettings = await getReportSettings();

  return (
    <div className="space-y-4">
      <h1 className="font-heading text-3xl font-bold leading-[0.95] sm:text-4xl">
        Settings
      </h1>

      <section className="rounded-xl border bg-card p-4">
        <div className="mb-4 space-y-1">
          <h2 className="font-heading text-2xl font-bold">
            Report And Export Settings
          </h2>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            Global report and export settings for this Lime server. Adjust the
            PDF, CSV, and LLM generation limits here and turn individual export
            formats on or off.
          </p>
        </div>
        <DashboardSettingsForm initialSettings={reportSettings} />
      </section>
    </div>
  );
}
