import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Dashboard from "./pages/Dashboard";
import Transactions from "./pages/Transactions";
import Import from "./pages/Import";
import Profile from "./pages/Profile";
import Admin from "./pages/Admin";

function BottomNav() {
  const { isAuthenticated, user } = useAuth();
  if (!isAuthenticated) return null;

  return (
    <nav className="bottom-nav">
      <NavLink to="/">Dashboard</NavLink>
      <NavLink to="/transactions">Transactions</NavLink>
      <NavLink to="/import">Import</NavLink>
      <NavLink to="/profile">Profile</NavLink>
      {user?.is_admin && <NavLink to="/admin">Admin</NavLink>}
    </nav>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/transactions" element={<ProtectedRoute><Transactions /></ProtectedRoute>} />
        <Route path="/import" element={<ProtectedRoute><Import /></ProtectedRoute>} />
        <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
        <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
      </Routes>
      <BottomNav />
    </BrowserRouter>
  );
}
