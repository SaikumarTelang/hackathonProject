# hackathonProject (Nova Nexus)

## What this is
Nova Nexus is an industrial procurement demo where **customers place orders in natural language** and the system:
1. **Verifies** requested items against `backend/industrial_manufacturing_dataset.csv`
2. **Reserves stock** by deducting quantities in the CSV
3. Creates an `Order` in MongoDB with status flow: `Received -> In Review -> Accepted`

The frontend shows:
- Customer chat for placing/canceling orders
- A customer-facing inventory list of available items (names only)
- A live orders table (with a process timeline)

## Tech Stack
### Backend
- Node.js + Express
- MongoDB + Mongoose
- Socket.io (real-time order updates)
- JWT auth + bcrypt password hashing
- Google Gemini (optional, with local fallback parsing)

### Frontend
- React + TypeScript + Vite
- Axios (API calls)
- Socket.io-client (live dashboard updates)

## Prerequisites
- Node.js (18+ recommended)
- MongoDB running locally (or provide a remote connection string)
- Optional: a Google Gemini API key (`GEMINI_API_KEY`)

## Environment Variables
Create a `.env` file inside `backend/`:

```bash
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=some_random_secret

# Optional (recommended): used for better intent extraction from chat
GEMINI_API_KEY=your_gemini_api_key

# Optional: demo operator seeding
DEMO_OPERATOR_EMAIL=operator@nova.local
DEMO_OPERATOR_PASSWORD=Operator@123
```

Notes:
- If `GEMINI_API_KEY` is missing or Gemini fails, the backend falls back to a local heuristic parser so basic ordering still works.

## Setup & Run
Open **two terminals**: one for backend, one for frontend.

### 1) Backend
```bash
cd backend
npm install
npm run dev
```
Backend runs on: `http://localhost:5000`

### 2) Frontend
```bash
cd frontend
npm install
npm run dev
```
Frontend runs on: Vite default port (usually `http://localhost:5173`).

## How to Use
### Login
Use the login screen in the UI:

- **Operator (demo)**
  - Email: `operator@nova.local`
  - Password: `Operator@123`

- **Customer (demo)**
  - Email: `customer@nova.local`
  - Password: `Customer@123`

If the customer account doesn’t exist yet, the app will auto-create it on first login.

### Place an Order (chat)
Example prompts:
- `I need 200 Stainless Steel Sheets by Monday`
- `i want to order Copper Wires of 60 units`
- `i want to order 10 Silicon Seals by 10 jan`

When your order is placed:
- Stock is checked & reserved using the CSV dataset
- Your order appears in the table as `Received`
- The system automatically progresses it to `In Review`, then `Accepted`

### Cancel or Delete an Order (chat)
Use your visible Order ID:
- Cancel: `cancel order #<orderId>`
- Delete: `delete order #<orderId>`

Cancel/Delete is allowed only while the order is still `Received` or `In Review` (accepted orders cannot be deleted).

## Inventory Dataset Behavior
`backend/industrial_manufacturing_dataset.csv` is treated as the source of truth for stock.
- On successful order placement, the system **deducts** quantities in the CSV.
- On cancel/delete, the system **restores** deducted quantities back into the CSV.

## Project Structure (high level)
- `backend/`
  - `routes/chat.js`: chatbot endpoint (place/cancel/delete orders)
  - `routes/orders.js`: orders API + customer scoping
  - `routes/catalog.js`: inventory list API for customers
  - `services/orderAgent.js`: dataset verification + reserve/restore logic
  - `services/orderAutomation.js`: automated operator review/accept scheduler
- `frontend/`
  - `src/App.tsx`: customer/operator UI + inventory display + orders table
  - `src/components/authApi.ts`: API client functions
