import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import PeoplePage from './pages/PeoplePage';
import NetworkPage from './pages/NetworkPage';
import PublicationsPage from './pages/PublicationsPage';
import InstitutionsPage from './pages/InstitutionsPage';

const tabs = [
  { to: '/people', label: 'People' },
  { to: '/network', label: 'Network' },
  { to: '/publications', label: 'Publications' },
  { to: '/institutions', label: 'Institutions' },
];

export default function App() {
  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center gap-6 border-b border-slate-200 bg-white px-6 py-3 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight">Academic CRM</h1>
        <nav className="flex gap-1">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/people" replace />} />
          <Route path="/people/:id?" element={<PeoplePage />} />
          <Route path="/network/:id?" element={<NetworkPage />} />
          <Route path="/publications" element={<PublicationsPage />} />
          <Route path="/institutions" element={<InstitutionsPage />} />
        </Routes>
      </main>
    </div>
  );
}
