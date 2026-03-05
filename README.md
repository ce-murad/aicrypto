# AI Crypto Investment Assistant

A macro-aware crypto investment assistant that combines technical analysis with real-time news risk filtering and risk-managed position sizing.

---

## Features

- **Coin picks & allocation** ranked by technical score, filtered by macro conditions
- **Entry / Stop Loss / Take Profit** levels with BUY / WAIT / AVOID signals
- **Macro risk banner** (GREEN / YELLOW / RED) powered by live news data
- **Risk-managed sizing** based on your budget and risk tolerance
- **Portfolio tracker** with live P&L via Binance price feeds
- **Price alerts** with browser notifications
- **Dark mode** with persistent preference
- **Auto-refresh** every 5 minutes

---

## Project Structure

```
aicrypto/
├── backend/
│   ├── main.py          # FastAPI backend
│   └── requirements.txt # Python dependencies
└── frontend/
    ├── src/
    │   ├── components/
    │   ├── context/
    │   ├── pages/
    │   ├── lib/
    │   └── types.ts
    ├── index.html
    └── package.json
```

---

## Getting Started

### Prerequisites

- Python 3.10+
- Node.js 18+
- npm or yarn

---

### Backend Setup

```bash
cd aicrypto/backend

# Create and activate virtual environment
python -m venv .venv

# On Mac/Linux:
source .venv/bin/activate

# On Windows:
.venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Start the backend
uvicorn main:app --reload --port 8000
```

The backend runs at `http://localhost:8000`.

---

### Frontend Setup

```bash
cd aicrypto/frontend

# Install dependencies
npm install

# Start the dev server
npm run dev
```

The frontend runs at `http://localhost:5173`.

---

### Environment Variables

Create a `.env` file in the `backend/` folder if your backend requires API keys:

```
GDELT_API_KEY=your_key_here
```

> Never commit `.env` files. They are listed in `.gitignore`.

---

## Deployment

See deployment instructions in the project wiki or contact the maintainer.

---

## Disclaimer

This tool is for educational purposes and structured decision support only. It is **not financial advice**. Always do your own research before making investment decisions.

---

## License

© 2025 Murad Abdullayev. All rights reserved.
