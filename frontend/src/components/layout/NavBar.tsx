import { NavLink } from 'react-router-dom';
import { useAppStore } from '../../stores/appStore.ts';

const navItems = [
  { to: '/', label: 'Upload' },
  { to: '/large-folder-upload', label: 'Large Folder Upload' },
  { to: '/files', label: 'Browse Uploaded Files' },
  { to: '/logs', label: 'History' },
];

interface NavBarProps {
  onAboutClick: () => void;
}

export default function NavBar({ onAboutClick }: NavBarProps) {
  const version = useAppStore((s) => s.version?.version);
  const openUpdateModal = useAppStore((s) => s.openUpdateModal);

  return (
    <nav className="nlr-menu-bar">
      <div className="nlr-menu-container">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => `nlr-menu-item${isActive ? ' active' : ''}`}
          >
            {item.label}
          </NavLink>
        ))}
        <div className="flex-grow" />
        {version && (
          <div className="flex items-center gap-1 mr-2">
            <button
              type="button"
              onClick={onAboutClick}
              className="text-xs font-mono bg-nlr-blue text-white px-2 py-1 rounded hover:bg-nlr-blue-light cursor-pointer transition-colors"
              title="About this application"
            >
              v{version}
            </button>
            <button
              type="button"
              onClick={openUpdateModal}
              className="text-xs font-mono bg-nlr-blue/80 text-white px-2 py-1 rounded hover:bg-nlr-blue cursor-pointer transition-colors"
              title="Check for updates / switch branch"
            >
              ↑
            </button>
          </div>
        )}
        <NavLink
          to="/delete"
          className={({ isActive }) => `nlr-menu-item${isActive ? ' active' : ''}`}
        >
          Clear Hard Drive
        </NavLink>
        <NavLink
          to="/settings"
          className={({ isActive }) => `nlr-menu-item${isActive ? ' active' : ''}`}
        >
          Settings
        </NavLink>
      </div>
    </nav>
  );
}
