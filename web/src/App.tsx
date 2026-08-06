import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useSuggestions } from './api/queries';
import PeoplePage from './pages/PeoplePage';
import PublicationsPage from './pages/PublicationsPage';
import InstitutionsPage from './pages/InstitutionsPage';

export default function App() {
  const suggestions = useSuggestions();
  const suggestionCount = suggestions.data?.length ?? 0;

  const tabs = [
    { to: '/people', label: 'People', badge: 0 },
    { to: '/publications', label: 'Publications', badge: suggestionCount },
    { to: '/institutions', label: 'Institutions', badge: 0 },
  ];

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
                `flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`
              }
            >
              {t.label}
              {t.badge > 0 && (
                <span className="rounded-full bg-amber-400 px-1.5 text-[10px] font-semibold text-amber-950">
                  {t.badge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="flex-1" />
        <a
          href="api/export"
          download
          className="text-xs text-slate-400 hover:text-slate-700"
          title="Download all data as JSON"
        >
          Export
        </a>
      </header>
      <main className="min-h-0 flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/people" replace />} />
          <Route path="/people/:id?" element={<PeoplePage />} />
          <Route path="/publications" element={<PublicationsPage />} />
          <Route path="/institutions" element={<InstitutionsPage />} />
          <Route path="*" element={<Navigate to="/people" replace />} />
        </Routes>
      </main>
    </div>
  );
}
