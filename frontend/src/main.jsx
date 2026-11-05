import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import App from './App.jsx';
import PublicPay from './pages/PublicPay.jsx';
import { applyTheme, watchSystemTheme } from './theme.js';
import './styles.css';

applyTheme();
watchSystemTheme();

// /pay/<token> is the customer-facing payment page and needs no login.
const isPublicPayPage = window.location.pathname.startsWith('/pay/');

ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode>{isPublicPayPage ? <PublicPay /> : <App />}</React.StrictMode>);
