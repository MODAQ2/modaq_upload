import { useEffect } from "react";
import { Route, Routes } from "react-router-dom";
import Layout from "./components/layout/Layout.tsx";
import DeletePage from "./pages/DeletePage.tsx";
import FilesPage from "./pages/FilesPage.tsx";
import LogsPage from "./pages/LogsPage.tsx";
import SettingsPage from "./pages/SettingsPage.tsx";
import UploadPage from "./pages/UploadPage.tsx";
import { useAppStore } from "./stores/appStore.ts";

export default function App() {
  const loadSettings = useAppStore((s) => s.loadSettings);
  const loadVersion = useAppStore((s) => s.loadVersion);

  useEffect(() => {
    loadSettings();
    loadVersion();
  }, [loadSettings, loadVersion]);

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<UploadPage />} />
        <Route path="delete" element={<DeletePage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
