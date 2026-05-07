import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import axios from 'axios';
import {
  fetchCatalog,
  fetchOrders,
  login,
  register,
  sendChat,
  type AuthUser,
  type Role
} from './components/authApi';

function App() {
  const getWelcomeMessage = (role?: Role) =>
    role === 'OPERATOR'
      ? 'Welcome Operator. You can review incoming customer orders, accept them, or delete them.'
      : 'Welcome! Place your manufacturing order in natural language (example: I need 200 steel brackets by Monday).';

  // Application State
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState<AuthUser | null>(() => {
    const raw = localStorage.getItem('user');
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('CUSTOMER');
  const [name, setName] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  
  const [orders, setOrders] = useState<any[]>([]);
  const [catalogItems, setCatalogItems] = useState<Array<{ itemName: string; availableQuantity: number }>>([]);
  const [customerOrderFilter, setCustomerOrderFilter] = useState<'ALL' | 'In Review' | 'Accepted' | 'Cancelled'>('ALL');
  const [chatInput, setChatInput] = useState('');
  const [chatLog, setChatLog] = useState([
    { sender: 'ai', text: getWelcomeMessage(user?.role) }
  ]);
  const [isTyping, setIsTyping] = useState(false);

  // Auto-scroll reference for the chat
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const ordersRef = useRef<any[]>([]);
  const notifiedAcceptedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  const syncOrders = async (notifyAccepted: boolean, seedAccepted: boolean = false) => {
    if (!token) return;
    try {
      const data = await fetchOrders(token);

      if (seedAccepted) {
        notifiedAcceptedRef.current = new Set(
          data.filter((o: any) => o.status === 'Accepted').map((o: any) => o._id)
        );
      }

      if (notifyAccepted && user?.role === 'CUSTOMER') {
        const previousStatusById = new Map(
          ordersRef.current.map((o: any) => [o._id, o.status])
        );

        const newlyAccepted = data.filter((order: any) => {
          const prev = previousStatusById.get(order._id);
          return (
            order.status === 'Accepted' &&
            prev !== 'Accepted' &&
            !notifiedAcceptedRef.current.has(order._id)
          );
        });

        newlyAccepted.forEach((order: any) => {
          notifiedAcceptedRef.current.add(order._id);
          setChatLog(prev => [
            ...prev,
            { sender: 'ai', text: `Your order #${order.orderId} has been accepted by the operator.` }
          ]);
        });
      }

      setOrders(data);
    } catch {
      // ignore
    }
  };

  const syncCatalog = async () => {
    if (!token) return;
    try {
      const data = await fetchCatalog(token);
      setCatalogItems(data.items || []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!token) return;
    syncOrders(false, true);
    syncCatalog();
  }, [token, user?.role]);

  // socket for live updates
  useEffect(() => {
    if (!token) return;
    const socket = io('http://localhost:5000');
    socketRef.current = socket;

    socket.on('orders:created', () => {
      syncOrders(true);
      syncCatalog();
    });
    socket.on('orders:updated', () => {
      syncOrders(true);
      syncCatalog();
    });
    socket.on('orders:deleted', () => {
      syncOrders(true);
      syncCatalog();
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token]);

  // Scroll to bottom whenever chatLog changes
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatLog, isTyping]);

  const refreshOrders = async () => {
    await syncOrders(false);
    await syncCatalog();
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      let res;
      if (authMode === 'register') {
        if (role !== 'CUSTOMER') {
          alert('Only customers can create accounts.');
          return;
        }
        if (password !== confirmPassword) {
          alert('Passwords do not match.');
          return;
        }
        await register({ email, password, role: 'CUSTOMER', name });
        res = await login({ email, password });
      } else {
        res = await login({ email, password });
      }

      setToken(res.token);
      setUser(res.user);
      notifiedAcceptedRef.current = new Set();
      setChatLog([{ sender: 'ai', text: getWelcomeMessage(res.user.role) }]);
      localStorage.setItem('token', res.token);
      localStorage.setItem('user', JSON.stringify(res.user));
      setAuthMode('login');
      setConfirmPassword('');
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        alert(err.response?.data?.msg || 'Login failed. Please check credentials.');
        return;
      }
      alert("Login failed. Please try again.");
    }
  };

  const handleLogout = () => {
    setToken('');
    setUser(null);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setOrders([]);
    setCatalogItems([]);
    setChatLog([{ sender: 'ai', text: 'Logged out. Please log in to continue.' }]);
  };

  const onSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const userMsg = chatInput;
    setChatLog(prev => [...prev, { sender: 'user', text: userMsg }]);
    setChatInput('');
    setIsTyping(true);

    try {
      const res = await sendChat(token, userMsg);
      
      setChatLog(prev => [...prev, { sender: 'ai', text: res.reply }]);
      refreshOrders(); 

    } catch (err) {
      setChatLog(prev => [...prev, { sender: 'ai', text: "Sorry, I encountered an error. Please try again." }]);
    } finally {
      setIsTyping(false);
    }
  };

  const renderProcessTrail = (order: any) => {
    const logs = Array.isArray(order.processLogs) ? order.processLogs : [];
    if (logs.length === 0) {
      return <span style={{ color: '#6b7280', fontSize: '12px' }}>Placed</span>;
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {logs.map((log: any, idx: number) => (
          <div key={`${order._id}-process-${idx}`} style={{ fontSize: '12px', color: '#374151' }}>
            <strong>{log.stage}</strong>
          </div>
        ))}
      </div>
    );
  };

  const renderOrderItems = (order: any) => {
    const items = Array.isArray(order.items) && order.items.length > 0
      ? order.items
      : [{ name: `${order.material || ''} ${order.partName || ''}`.trim() || 'Item', quantity: order.quantity || 0 }];

    return (
      <div>
        <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '6px' }}>
          {items.length} product{items.length > 1 ? 's' : ''}
        </div>
        {items.map((item: any, idx: number) => (
          <div key={`${order._id}-item-${idx}`} style={{ marginBottom: '4px' }}>
            <strong>{item.name}</strong> - Qty: {item.quantity}
          </div>
        ))}
      </div>
    );
  };

  const renderOrdersTable = () => (
    <div style={{ flex: 1, overflowY: 'auto', padding: '0' }}>
      {isCustomer && (
        <div style={{ padding: '12px 15px', borderBottom: '1px solid #e5e7eb', background: '#f8fafc', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ fontSize: '13px', color: '#374151', fontWeight: 600 }}>View Orders:</label>
          <select
            value={customerOrderFilter}
            onChange={e => setCustomerOrderFilter(e.target.value as 'ALL' | 'In Review' | 'Accepted' | 'Cancelled')}
            style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px', outline: 'none' }}
          >
            <option value="ALL">All</option>
            <option value="In Review">In Review</option>
            <option value="Accepted">Accepted</option>
            <option value="Cancelled">Cancelled</option>
          </select>
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
        <thead style={{ position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 1 }}>
          <tr>
            <th style={{ padding: '15px', borderBottom: '2px solid #e5e7eb', color: '#4b5563' }}>ID</th>
            <th style={{ padding: '15px', borderBottom: '2px solid #e5e7eb', color: '#4b5563' }}>Details</th>
            <th style={{ padding: '15px', borderBottom: '2px solid #e5e7eb', color: '#4b5563' }}>Deadline</th>
            <th style={{ padding: '15px', borderBottom: '2px solid #e5e7eb', color: '#4b5563' }}>Status</th>
            <th style={{ padding: '15px', borderBottom: '2px solid #e5e7eb', color: '#4b5563' }}>Process</th>
            <th style={{ padding: '15px', borderBottom: '2px solid #e5e7eb', color: '#4b5563' }}>Latest Quality Note</th>
          </tr>
        </thead>
        <tbody>
          {(isCustomer
            ? orders.filter(o => customerOrderFilter === 'ALL' ? true : o.status === customerOrderFilter)
            : orders
          ).length === 0 ? (
            <tr><td colSpan={6} style={{ padding: '30px', textAlign: 'center', color: '#6b7280' }}>No orders yet.</td></tr>
          ) : (
            (isCustomer
              ? orders.filter(o => customerOrderFilter === 'ALL' ? true : o.status === customerOrderFilter)
              : orders
            ).map(order => (
              <tr key={order._id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                <td style={{ padding: '15px', fontWeight: 'bold', color: '#111827' }}>#{order.orderId}</td>
                <td style={{ padding: '15px', color: '#374151' }}>{renderOrderItems(order)}</td>
                <td style={{ padding: '15px', color: '#374151' }}>{order.deadline}</td>
                <td style={{ padding: '15px' }}>
                  <span style={{
                    padding: '6px 10px', borderRadius: '20px', fontSize: '13px', fontWeight: 'bold',
                    background: order.status === 'Received' ? '#fef3c7' : order.status === 'In Review' ? '#dbeafe' : order.status === 'Cancelled' ? '#fee2e2' : '#d1fae5',
                    color: order.status === 'Received' ? '#d97706' : order.status === 'In Review' ? '#1d4ed8' : order.status === 'Cancelled' ? '#b91c1c' : '#059669'
                  }}>
                    {order.status}
                  </span>
                </td>
                <td style={{ padding: '15px', color: '#374151', fontSize: '13px' }}>
                  {renderProcessTrail(order)}
                </td>
                <td style={{ padding: '15px', color: '#374151', fontSize: '13px' }}>
                  {order.qualityLogs?.length > 0 ? order.qualityLogs[order.qualityLogs.length - 1].note : 'No quality note'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );

  // --- LOGIN SCREEN ---
  if (!token || !user) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', backgroundColor: '#f3f4f6', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ background: 'white', padding: '40px', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)', width: '100%', maxWidth: '400px' }}>
          <h2 style={{ textAlign: 'center', marginBottom: '20px', color: '#1f2937' }}>Nova Nexus System</h2>
          <div style={{ marginBottom: '14px', padding: '10px 12px', borderRadius: '8px', background: '#ecfeff', border: '1px solid #a5f3fc', color: '#0f172a', fontSize: '13px', lineHeight: '1.5' }}>
            <strong>Default Operator Login</strong><br />
            Email: <code>operator@nova.local</code><br />
            Password: <code>Operator@123</code>
          </div>
          <div style={{ marginBottom: '14px', padding: '10px 12px', borderRadius: '8px', background: '#f0fdf4', border: '1px solid #86efac', color: '#052e16', fontSize: '13px', lineHeight: '1.5' }}>
            <strong>Customer Access</strong><br />
            Customers should create their own accounts using the <em>Customer + Register</em> options below.<br />
            <span style={{ color: '#166534' }}>
              Operator accounts are fixed for the system demo; only customers can register new users.
            </span>
          </div>
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            <select
              value={role}
              onChange={e => {
                const nextRole = e.target.value as Role;
                setRole(nextRole);
                if (nextRole !== 'CUSTOMER') {
                  setAuthMode('login');
                  setConfirmPassword('');
                }
              }}
              style={{ padding: '12px', borderRadius: '6px', border: '1px solid #d1d5db', outline: 'none' }}
            >
              <option value="CUSTOMER">Customer</option>
              <option value="OPERATOR">Operator</option>
            </select>
            <input type="text" placeholder="Name (optional)" value={name} onChange={e => setName(e.target.value)} style={{ padding: '12px', borderRadius: '6px', border: '1px solid #d1d5db', outline: 'none' }} />
            <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required style={{ padding: '12px', borderRadius: '6px', border: '1px solid #d1d5db', outline: 'none' }} />
            <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required style={{ padding: '12px', borderRadius: '6px', border: '1px solid #d1d5db', outline: 'none' }} />
            {role === 'CUSTOMER' && (
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('login');
                    setConfirmPassword('');
                  }}
                  style={{
                    flex: 1,
                    padding: '10px',
                    background: authMode === 'login' ? '#2563eb' : '#e5e7eb',
                    color: authMode === 'login' ? 'white' : '#111827',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: 700
                  }}
                >
                  Login
                </button>
                <button
                  type="button"
                  onClick={() => setAuthMode('register')}
                  style={{
                    flex: 1,
                    padding: '10px',
                    background: authMode === 'register' ? '#10b981' : '#e5e7eb',
                    color: authMode === 'register' ? 'white' : '#111827',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: 700
                  }}
                >
                  Register
                </button>
              </div>
            )}
            {role === 'CUSTOMER' && authMode === 'register' && (
              <input
                type="password"
                placeholder="Confirm Password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
                style={{ padding: '12px', borderRadius: '6px', border: '1px solid #d1d5db', outline: 'none' }}
              />
            )}
            <button
              type="submit"
              style={{ padding: '12px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '16px' }}
            >
              {role === 'CUSTOMER' && authMode === 'register' ? 'Create Account' : 'Continue'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // --- MAIN APP LAYOUT ---
  const totalOrders = orders.length;
  const receivedCount = orders.filter(o => o.status === 'Received').length;
  const inReviewCount = orders.filter(o => o.status === 'In Review').length;
  const acceptedCount = orders.filter(o => o.status === 'Accepted').length;
  const isCustomer = user.role === 'CUSTOMER';

  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui, sans-serif', maxWidth: '1400px', margin: '0 auto', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', padding: '10px 20px', background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
        <h1 style={{ margin: 0, fontSize: '24px', color: '#1f2937' }}>
          {user.role === 'OPERATOR' ? 'Operator Dashboard' : 'Customer Portal'}
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '13px', padding: '5px 10px', borderRadius: '999px', background: user.role === 'OPERATOR' ? '#dbeafe' : '#dcfce7', color: user.role === 'OPERATOR' ? '#1d4ed8' : '#166534', fontWeight: 700 }}>
            {user.role}
          </span>
        <button onClick={handleLogout} style={{ padding: '8px 16px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>Logout</button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: '20px', flex: 1, minHeight: 0 }}>
        
        {/* LEFT COLUMN: The AI Chatbot */}
        <div style={{ flex: '1', background: 'white', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ background: '#2563eb', color: 'white', padding: '15px 20px', fontWeight: 'bold', fontSize: '18px' }}>
            {user.role === 'OPERATOR' ? 'Operator AI Console' : 'Order with Natural Language'}
          </div>
          
          <div style={{ flex: '1', padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '15px', backgroundColor: '#f9fafb' }}>
            {chatLog.map((msg, idx) => (
              <div key={idx} style={{ 
                alignSelf: msg.sender === 'user' ? 'flex-end' : 'flex-start',
                background: msg.sender === 'user' ? '#2563eb' : '#ffffff',
                color: msg.sender === 'user' ? 'white' : '#1f2937',
                padding: '12px 16px',
                borderRadius: msg.sender === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                border: msg.sender === 'ai' ? '1px solid #e5e7eb' : 'none',
                maxWidth: '80%',
                boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                lineHeight: '1.4'
              }}>
                {msg.text}
              </div>
            ))}
            {isTyping && (
              <div style={{ alignSelf: 'flex-start', color: '#6b7280', fontSize: '14px', fontStyle: 'italic', padding: '0 10px' }}>
                AI is typing...
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <form onSubmit={onSendChat} style={{ display: 'flex', padding: '15px', background: 'white', borderTop: '1px solid #e5e7eb' }}>
            <input 
              type="text" 
              value={chatInput} 
              onChange={e => setChatInput(e.target.value)} 
              placeholder="e.g., I need 200 titanium flanges by July 20..."
              style={{ flex: '1', padding: '12px 15px', borderRadius: '24px', border: '1px solid #d1d5db', outline: 'none', marginRight: '10px', fontSize: '15px' }}
            />
            <button type="submit" style={{ padding: '10px 24px', background: '#10b981', color: 'white', border: 'none', borderRadius: '24px', cursor: 'pointer', fontWeight: 'bold' }}>Send</button>
          </form>
        </div>

        {/* RIGHT COLUMN: Live Dashboard */}
        <div style={{ flex: '1.5', background: 'white', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '20px', borderBottom: '1px solid #e5e7eb' }}>
            <h2 style={{ margin: 0, color: '#1f2937' }}>
              {isCustomer ? 'Order & Inventory Dashboard' : 'Order Dashboard (Read-only)'}
            </h2>
            <div style={{ marginTop: '10px', display: 'flex', gap: '16px', flexWrap: 'wrap', color: '#374151', fontSize: '13px' }}>
              <span><strong>Total Orders Placed:</strong> {totalOrders}</span>
              <span><strong>Received:</strong> {receivedCount}</span>
              <span><strong>In Review:</strong> {inReviewCount}</span>
              <span><strong>Accepted:</strong> {acceptedCount}</span>
              {isCustomer && <span><strong>Available Catalog Items:</strong> {catalogItems.length}</span>}
            </div>
            <div style={{ marginTop: '8px', color: '#6b7280', fontSize: '12px' }}>
              Order IDs: {orders.length > 0 ? orders.map(o => `#${o.orderId}`).join(', ') : 'None'}
            </div>
          </div>

          {isCustomer && (
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', background: '#f8fafc' }}>
              <div style={{ fontWeight: 700, color: '#1f2937', marginBottom: '8px' }}>
                Available Items
              </div>
              <div style={{ maxHeight: '140px', overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: '8px', background: 'white' }}>
                {catalogItems.length === 0 ? (
                  <div style={{ padding: '10px 12px', fontSize: '13px', color: '#6b7280' }}>No catalog data available.</div>
                ) : (
                  catalogItems.map((item, idx) => (
                    <div
                      key={`${item.itemName}-${idx}`}
                      style={{
                        display: 'flex',
                        justifyContent: 'flex-start',
                        padding: '8px 12px',
                        borderBottom: idx === catalogItems.length - 1 ? 'none' : '1px solid #f1f5f9',
                        fontSize: '13px',
                        color: '#334155'
                      }}
                    >
                      <span>{item.itemName}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {renderOrdersTable()}
        </div>

      </div>
    </div>
  );
}

export default App;