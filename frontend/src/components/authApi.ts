import axios from 'axios';

const API_BASE = 'http://localhost:5000/api';

export type Role = 'CUSTOMER' | 'OPERATOR';

export type AuthUser = {
  id: string;
  email: string;
  role: Role;
  name?: string;
};

export async function register(params: {
  email: string;
  password: string;
  role: Role;
  name?: string;
}) {
  const res = await axios.post(`${API_BASE}/auth/register`, params);
  return res.data as { msg: string };
}

export async function login(params: { email: string; password: string }) {
  const res = await axios.post(`${API_BASE}/auth/login`, params);
  return res.data as { token: string; msg: string; user: AuthUser };
}

export async function fetchOrders(token: string) {
  const res = await axios.get(`${API_BASE}/orders`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data;
}

export async function fetchCatalog(token: string) {
  const res = await axios.get(`${API_BASE}/catalog`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data as { items: Array<{ itemName: string; availableQuantity: number }> };
}

export async function cancelOrder(token: string, id: string) {
  const res = await axios.post(
    `${API_BASE}/orders/${id}/cancel`,
    {},
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data;
}

export async function updateOrderStatus(token: string, id: string, status: string) {
  const res = await axios.patch(
    `${API_BASE}/orders/${id}/status`,
    { status },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data;
}

export async function deleteOrder(token: string, id: string) {
  const res = await axios.delete(`${API_BASE}/orders/${id}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data as { msg: string; id: string };
}

export async function sendChat(token: string, message: string) {
  const res = await axios.post(
    `${API_BASE}/chat`,
    { message },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data as { reply: string; order?: unknown };
}

export async function cancelOrderByOrderId(token: string, orderId: number) {
  const res = await axios.post(
    `${API_BASE}/orders/by-order-id/${orderId}/cancel`,
    {},
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data;
}

export async function deleteOrderByOrderId(token: string, orderId: number) {
  const res = await axios.delete(`${API_BASE}/orders/by-order-id/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data as { msg: string; orderId: number };
}
