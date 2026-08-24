import { DashboardSettingsForm } from "@/components/dashboard-settings-form";
import { getSystemSettings } from "@/lib/report-settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getSystemSettings();

  return (
    <div className="mx-auto w-full max-w-[760px] space-y-5">
      <div>
        <h1 className="lime-page-title">Settings</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
          Server-wide defaults for reports, caching, and integrations. Changes
          apply to new requests immediately.
        </p>
      </div>

      <section>
        <DashboardSettingsForm initialSettings={settings} />
      </section>
    </div>
  );
}
