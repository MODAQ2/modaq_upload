import { useAppStore } from "../../stores/appStore.ts";

export default function Header() {
  const displayName = useAppStore((s) => s.settings?.display_name ?? "MODAQ Upload");

  return (
    <header className="nlr-header">
      <div className="nlr-header-top">
        <h1 className="nlr-header-title">{displayName}</h1>
        <a href="https://www.nlr.gov" target="_blank" rel="noopener noreferrer">
          <img
            src="/images/nlr-logo@2x-01.png"
            alt="National Laboratory of the Rockies"
            className="nlr-logo-image"
          />
        </a>
      </div>
    </header>
  );
}
