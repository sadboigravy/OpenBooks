import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { AppContext, api, post, setCurrency, useApp } from './lib.jsx';
import { Loading } from './components/ui.jsx';
import { GearMenu, GlobalSearch, NewMenu, Popover } from './components/shell.jsx';
import { AssistantButton } from './components/Assistant.jsx';
import { getThemePreference, resolvedTheme, setThemePreference } from './theme.js';
import Login from './pages/Login.jsx';
import SetupAdmin from './pages/SetupAdmin.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Contacts from './pages/Contacts.jsx';
import ContactDetail from './pages/ContactDetail.jsx';
import AllSales from './pages/AllSales.jsx';
import Invoices from './pages/Invoices.jsx';
import Estimates from './pages/Estimates.jsx';
import SalesForm from './pages/SalesForm.jsx';
import SalesView from './pages/SalesView.jsx';
import ReceivePayment from './pages/ReceivePayment.jsx';
import Items from './pages/Items.jsx';
import ExpensesList from './pages/ExpensesList.jsx';
import ExpenseForm from './pages/ExpenseForm.jsx';
import Bills from './pages/Bills.jsx';
import BillForm from './pages/BillForm.jsx';
import BillView from './pages/BillView.jsx';
import PayBills from './pages/PayBills.jsx';
import Banking from './pages/Banking.jsx';
import { BankConnectCallback } from './components/BankFeeds.jsx';
import DepositForm from './pages/DepositForm.jsx';
import TransferForm from './pages/TransferForm.jsx';
import Reconcile from './pages/Reconcile.jsx';
import ReconcileWorkspace from './pages/ReconcileWorkspace.jsx';
import Accounts from './pages/Accounts.jsx';
import JournalEntries from './pages/JournalEntries.jsx';
import JournalForm from './pages/JournalForm.jsx';
import Employees from './pages/Employees.jsx';
import EmployeeDetail from './pages/EmployeeDetail.jsx';
import Timesheets from './pages/Timesheets.jsx';
import Payroll from './pages/Payroll.jsx';
import RunPayroll from './pages/RunPayroll.jsx';
import PayrollRunView from './pages/PayrollRunView.jsx';
import Reports from './pages/Reports.jsx';
import Taxes from './pages/Taxes.jsx';
import PayrollTax from './pages/PayrollTax.jsx';
import IncomeTax from './pages/IncomeTax.jsx';
import Report from './pages/Report.jsx';
import Settings from './pages/Settings.jsx';
import Users from './pages/Users.jsx';

const NAV = [
  { label: 'Dashboard', to: '/', icon: '◧' },
  {
    label: 'Banking',
    icon: '⌂',
    items: [
      ['Bank transactions', '/banking'],
      ['Reconcile', '/reconcile'],
    ],
  },
  {
    label: 'Sales',
    icon: '▤',
    items: [
      ['All sales', '/sales'],
      ['Invoices', '/invoices'],
      ['Estimates', '/estimates'],
      ['Customers', '/customers'],
      ['Products & services', '/items'],
    ],
  },
  {
    label: 'Expenses',
    icon: '◔',
    items: [
      ['Expenses', '/expenses'],
      ['Bills', '/bills'],
      ['Vendors', '/vendors'],
    ],
  },
  {
    label: 'Payroll',
    icon: '⚇',
    items: [
      ['Employees', '/employees'],
      ['Timesheets', '/time'],
      ['Payroll', '/payroll'],
    ],
  },
  {
    label: 'Taxes',
    icon: '§',
    items: [
      ['Sales tax', '/taxes'],
      ['Payroll tax', '/taxes/payroll'],
      ['Income tax', '/taxes/income'],
    ],
  },
  { label: 'Reports', to: '/reports', icon: '▦' },
  {
    label: 'Accounting',
    icon: '☰',
    items: [
      ['Chart of accounts', '/accounts'],
      ['Journal entries', '/journal'],
    ],
  },
];

function NavGroup({ group }) {
  const location = useLocation();
  const inGroup = group.items.some(([, to]) => location.pathname === to || location.pathname.startsWith(`${to}/`));
  const [open, setOpen] = useState(inGroup);
  useEffect(() => {
    if (inGroup) setOpen(true);
  }, [inGroup]);
  return (
    <div className={`nav-group ${open ? 'open' : ''}`}>
      <button type="button" className={`nav-link nav-parent ${inGroup ? 'has-active' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="nav-icon" aria-hidden="true">
          {group.icon}
        </span>
        {group.label}
        <span className="nav-caret" aria-hidden="true">
          ▸
        </span>
      </button>
      {open && (
        <div className="nav-children">
          {group.items.map(([label, to]) => (
            <NavLink key={to} to={to} end className="nav-link nav-child">
              {label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

function Sidebar({ open }) {
  const { settings } = useApp();
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="brand">
        <img src="/logo-mark.svg" alt="" width="32" height="32" />
        <div>
          <div className="brand-name">
            Open<span className="brand-accent">Books</span>
          </div>
          <div className="brand-company" title={settings.company_name}>
            {settings.company_name}
          </div>
        </div>
      </div>
      <div className="sidebar-new">
        <NewMenu />
      </div>
      <nav>
        {NAV.map((g) =>
          g.items ? (
            <NavGroup key={g.label} group={g} />
          ) : (
            <NavLink key={g.to} to={g.to} end={g.to === '/'} className="nav-link">
              <span className="nav-icon" aria-hidden="true">
                {g.icon}
              </span>
              {g.label}
            </NavLink>
          ),
        )}
      </nav>
    </aside>
  );
}

function ThemeSwitch() {
  const { themePref } = useApp();
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Appearance">
      {[
        ['light', 'Light'],
        ['dark', 'Dark'],
        ['system', 'System'],
      ].map(([value, label]) => (
        <button key={value} type="button" role="radio" aria-checked={themePref === value} className={themePref === value ? 'active' : ''} onClick={() => setThemePreference(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function UserMenu() {
  const { user, signOut } = useApp();
  return (
    <Popover
      align="right"
      trigger={({ toggle }) => (
        <button type="button" className="user-chip" onClick={toggle} aria-label="Account menu">
          <span className="avatar">{(user.name || user.email).charAt(0).toUpperCase()}</span>
          <span className="user-name">
            {user.name || user.email}
            <small>{user.role}</small>
          </span>
        </button>
      )}
    >
      <div className="menu-list">
        <div className="menu-head">
          <strong>{user.name}</strong>
          <small className="muted">{user.email}</small>
        </div>
        <div className="menu-label">Appearance</div>
        <ThemeSwitch />
        <a href="/settings#password">Change password</a>
        <button type="button" data-close onClick={signOut}>
          Sign out
        </button>
      </div>
    </Popover>
  );
}

function Shell() {
  const { user, toast, canEdit } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="shell">
      <Sidebar open={menuOpen} />
      {menuOpen && <div className="sidebar-scrim" onClick={() => setMenuOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            ☰
          </button>
          <GlobalSearch />
          <div className="topbar-spacer" />
          <AssistantButton />
          <GearMenu />
          <UserMenu />
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            {/* Sales */}
            <Route path="/sales" element={<AllSales />} />
            <Route path="/invoices" element={<Invoices />} />
            <Route path="/estimates" element={<Estimates />} />
            <Route path="/invoices/new" element={canEdit ? <SalesForm kind="invoice" /> : <Navigate to="/invoices" replace />} />
            <Route path="/invoices/:id/edit" element={canEdit ? <SalesForm kind="invoice" /> : <Navigate to="/invoices" replace />} />
            <Route path="/invoices/:id" element={<SalesView kind="invoice" />} />
            <Route path="/estimates/new" element={canEdit ? <SalesForm kind="estimate" /> : <Navigate to="/estimates" replace />} />
            <Route path="/estimates/:id/edit" element={canEdit ? <SalesForm kind="estimate" /> : <Navigate to="/estimates" replace />} />
            <Route path="/estimates/:id" element={<SalesView kind="estimate" />} />
            <Route path="/sales-receipts/new" element={canEdit ? <SalesForm kind="sales_receipt" /> : <Navigate to="/sales" replace />} />
            <Route path="/sales-receipts/:id/edit" element={canEdit ? <SalesForm kind="sales_receipt" /> : <Navigate to="/sales" replace />} />
            <Route path="/sales-receipts/:id" element={<SalesView kind="sales_receipt" />} />
            <Route path="/receive-payment" element={canEdit ? <ReceivePayment /> : <Navigate to="/invoices" replace />} />
            <Route path="/customers" element={<Contacts kind="customers" />} />
            <Route path="/customers/:id" element={<ContactDetail kind="customers" />} />
            <Route path="/items" element={<Items />} />
            {/* Expenses */}
            <Route path="/expenses" element={<ExpensesList />} />
            <Route path="/expenses/new" element={canEdit ? <ExpenseForm /> : <Navigate to="/expenses" replace />} />
            <Route path="/checks/new" element={canEdit ? <ExpenseForm check /> : <Navigate to="/expenses" replace />} />
            <Route path="/expenses/:id/edit" element={canEdit ? <ExpenseForm /> : <Navigate to="/expenses" replace />} />
            <Route path="/bills" element={<Bills />} />
            <Route path="/bills/new" element={canEdit ? <BillForm /> : <Navigate to="/bills" replace />} />
            <Route path="/bills/:id" element={<BillView />} />
            <Route path="/bills/:id/edit" element={canEdit ? <BillForm /> : <Navigate to="/bills" replace />} />
            <Route path="/pay-bills" element={canEdit ? <PayBills /> : <Navigate to="/bills" replace />} />
            <Route path="/vendors" element={<Contacts kind="vendors" />} />
            <Route path="/vendors/:id" element={<ContactDetail kind="vendors" />} />
            {/* Banking */}
            <Route path="/banking" element={<Banking />} />
            <Route path="/banking/connect/callback" element={<BankConnectCallback />} />
            <Route path="/deposits/new" element={canEdit ? <DepositForm /> : <Navigate to="/banking" replace />} />
            <Route path="/deposits/:id" element={<DepositForm />} />
            <Route path="/transfers/new" element={canEdit ? <TransferForm /> : <Navigate to="/banking" replace />} />
            <Route path="/transfers/:id" element={<TransferForm />} />
            <Route path="/reconcile" element={<Reconcile />} />
            <Route path="/reconcile/:accountId" element={<ReconcileWorkspace />} />
            {/* Payroll */}
            <Route path="/employees" element={<Employees />} />
            <Route path="/employees/:id" element={<EmployeeDetail />} />
            <Route path="/time" element={<Timesheets />} />
            <Route path="/payroll" element={<Payroll />} />
            <Route path="/payroll/run" element={canEdit ? <RunPayroll /> : <Navigate to="/payroll" replace />} />
            <Route path="/payroll/runs/:id" element={<PayrollRunView />} />
            {/* Accounting & reports */}
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/journal" element={<JournalEntries />} />
            <Route path="/journal/new" element={canEdit ? <JournalForm /> : <Navigate to="/journal" replace />} />
            <Route path="/journal/:id" element={<JournalForm />} />
            <Route path="/taxes" element={<Taxes />} />
            <Route path="/taxes/payroll" element={<PayrollTax />} />
            <Route path="/taxes/income" element={<IncomeTax />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/reports/:type" element={<Report />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/users" element={user.role === 'admin' ? <Users /> : <Navigate to="/" />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
      {toast && <div className={`toast toast-${toast.kind}`}>{toast.message}</div>}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking session
  const [settings, setSettings] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [items, setItems] = useState(null);
  const [toast, setToast] = useState(null);
  const [themePref, setThemePref] = useState(getThemePreference);
  const [theme, setTheme] = useState(resolvedTheme);

  useEffect(() => {
    const onTheme = () => {
      setThemePref(getThemePreference());
      setTheme(resolvedTheme());
    };
    window.addEventListener('openbooks:theme', onTheme);
    return () => window.removeEventListener('openbooks:theme', onTheme);
  }, []);

  const refreshSettings = useCallback(
    () =>
      api('/settings').then((s) => {
        setCurrency(s.currency);
        setSettings(s);
      }),
    [],
  );
  const refreshAccounts = useCallback(() => api('/accounts?include_inactive=1').then(setAccounts), []);
  const refreshItems = useCallback(() => api('/items?include_inactive=1').then(setItems), []);
  const [taxSetup, setTaxSetup] = useState(null);
  const refreshTax = useCallback(() => api('/tax/setup').then(setTaxSetup), []);

  useEffect(() => {
    api('/auth/me')
      .then(setUser)
      .catch(() => setUser(null));
    const onSignedOut = () => setUser(null);
    window.addEventListener('openbooks:signed-out', onSignedOut);
    return () => window.removeEventListener('openbooks:signed-out', onSignedOut);
  }, []);

  useEffect(() => {
    if (user && !user.setup_required) {
      refreshSettings();
      refreshAccounts();
      refreshItems();
      refreshTax();
    }
  }, [user, refreshSettings, refreshAccounts, refreshItems, refreshTax]);

  const notify = useCallback((message, kind = 'success') => {
    setToast({ message, kind });
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => setToast(null), 3500);
  }, []);

  const signOut = useCallback(async () => {
    await post('/auth/logout').catch(() => {});
    setUser(null);
    setSettings(null);
    setAccounts(null);
    setItems(null);
  }, []);

  const ctx = useMemo(
    () => ({
      user,
      setUser,
      settings,
      refreshSettings,
      accounts,
      refreshAccounts,
      items,
      refreshItems,
      taxSetup,
      refreshTax,
      notify,
      toast,
      signOut,
      canEdit: user && user.role !== 'viewer',
      theme,
      themePref,
    }),
    [user, settings, accounts, items, taxSetup, refreshSettings, refreshAccounts, refreshItems, refreshTax, notify, toast, signOut, theme, themePref],
  );

  if (user === undefined) return <Loading />;
  if (user?.setup_required) return <SetupAdmin onDone={setUser} onSignOut={signOut} />;

  return (
    <AppContext.Provider value={ctx}>
      <BrowserRouter>{user === null ? <Login onLogin={setUser} /> : settings && accounts && items && taxSetup ? <Shell /> : <Loading />}</BrowserRouter>
    </AppContext.Provider>
  );
}
