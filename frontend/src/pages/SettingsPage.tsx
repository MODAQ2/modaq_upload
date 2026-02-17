import { useEffect } from "react";
import CacheSection from "../components/settings/CacheSection.tsx";
import DangerZone from "../components/settings/DangerZone.tsx";
import SettingsForm from "../components/settings/SettingsForm.tsx";
import UpdateSection from "../components/settings/UpdateSection.tsx";
import { useAppStore } from "../stores/appStore.ts";

export default function SettingsPage() {
  const { loadSettings, settingsLoading } = useAppStore();

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  if (settingsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="spinner h-8 w-8 border-4 border-nlr-blue border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h2 className="text-xl font-semibold text-nlr-text">Settings</h2>
      <SettingsForm />
      <UpdateSection />
      <CacheSection />
      <DangerZone />
    </div>
  );
}
