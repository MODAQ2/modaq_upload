import { useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';
import Layout from './components/layout/Layout.tsx';
import UpdateModal from './components/settings/UpdateModal.tsx';
import DeletePage from './pages/DeletePage.tsx';
import FilesPage from './pages/FilesPage.tsx';
import LargeFolderUploadPage from './pages/LargeFolderUploadPage.tsx';
import LogsPage from './pages/LogsPage.tsx';
import SettingsPage from './pages/SettingsPage.tsx';
import UploadPage from './pages/UploadPage.tsx';
import { useAppStore } from './stores/appStore.ts';

export default function App() {
  const loadSettings = useAppStore((s) => s.loadSettings);
  const loadVersion = useAppStore((s) => s.loadVersion);
  const runAutoCheck = useAppStore((s) => s.runAutoCheck);

  useEffect(() => {
    loadSettings();
    loadVersion();
    runAutoCheck();
  }, [loadSettings, loadVersion, runAutoCheck]);

  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<UploadPage />} />
          <Route path="delete" element={<DeletePage />} />
          <Route path="files" element={<FilesPage />} />
          <Route path="large-folder-upload" element={<LargeFolderUploadPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
      <UpdateModal />
    </>
  );
}
