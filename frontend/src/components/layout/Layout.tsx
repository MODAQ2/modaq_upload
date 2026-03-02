import { useState } from "react";
import { Outlet } from "react-router-dom";
import NotificationStack from "../common/Notification.tsx";
import AboutModal from "./AboutModal.tsx";
import Footer from "./Footer.tsx";
import Header from "./Header.tsx";
import NavBar from "./NavBar.tsx";

export default function Layout() {
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <div className="bg-gray-50 min-h-screen flex flex-col font-[family-name:var(--font-family-roboto)]">
      <Header />
      <NavBar onAboutClick={() => setAboutOpen(true)} />
      <main className="max-w-5xl w-full mx-auto px-4 py-8 flex-grow">
        <Outlet />
      </main>
      <Footer />
      <AboutModal isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />
      <NotificationStack />
    </div>
  );
}
