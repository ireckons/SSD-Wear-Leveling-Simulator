# ⚡ SSD Wear-Leveling Simulator

A fully interactive Python simulator that demonstrates how SSD lifespans are extended by distributing writes across NAND flash blocks. Compare **No Wear-Leveling** vs **Dynamic WL** vs **Static WL** in real-time.

![Python](https://img.shields.io/badge/Python-3.8+-3776AB?logo=python&logoColor=white)
![Tkinter](https://img.shields.io/badge/GUI-Tkinter-blue)
![Matplotlib](https://img.shields.io/badge/Graphs-Matplotlib-orange)

---

## 🎯 What It Does

In a real SSD, the **Flash Translation Layer (FTL)** sits between the OS and raw NAND flash. One of the FTL's critical responsibilities is **wear leveling** — distributing erase/program cycles evenly across all blocks to prevent premature failure.

This simulator models three wear-leveling strategies on a 10×10 grid of flash blocks:

| Algorithm | Strategy | Use Case |
|-----------|----------|----------|
| 🚫 **No Wear Leveling** | Sequential writes to the next logical address | Early SSDs / USB drives |
| ⚡ **Dynamic WL** | Always write to the least-worn free block | Consumer SSDs (Samsung EVO, Crucial MX) |
| 🔄 **Static WL** | Dynamic WL + periodic cold-data migration | Enterprise SSDs (Intel DC, Samsung PM) |

---

## 🖥️ Features

- **Visual Block Grid** — Color-coded 10×10 grid (Green → Yellow → Red → Black)
- **Real-Time Graph** — Matplotlib chart showing Wear Standard Deviation over time
- **Live Statistics** — Dead/alive blocks, avg/max/min wear, std dev
- **Summary Report** — Detailed popup with results and algorithm interpretation
- **Hover Tooltips** — Hover any block to see its exact wear stats
- **Animated Simulation** — Watch writes happen in real-time at ~30fps

---

## 🚀 Getting Started

### Prerequisites

- Python 3.8 or higher
- `tkinter` (included with Python on most systems)
- `matplotlib`

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/SSD-Wear-Leveling-Simulator.git
cd SSD-Wear-Leveling-Simulator

# Install dependencies
pip install matplotlib

# Run the simulator
python ssd_simulator.py
```

---

## 📖 How to Use

1. **Select an Algorithm** — Choose from the three radio buttons on the left panel
2. **Set Write Count** — Default is 1,000 (adjustable)
3. **Click ▶ RUN SIMULATION** — Watch blocks change color as writes are distributed
4. **Compare Results** — Reset and try a different algorithm
5. **Read the Summary** — A report popup shows dead blocks, wear deviation, and interpretation

---

## 🔬 What to Observe

| Metric | No WL | Dynamic WL | Static WL |
|--------|-------|------------|-----------|
| Wear Std Dev | **High** 📈 | Medium | **Low** 📉 |
| Dead Blocks | **Many** | Few | **Fewest** |
| Wear Distribution | Uneven | Moderate | **Most Even** |

- **Naive mode**: A few blocks turn red/black while most stay green — catastrophic hotspot wear
- **Dynamic WL**: Much more even coloring — but cold-data blocks stay underutilized
- **Static WL**: The most uniform wear — cold data is periodically migrated to balance the pool

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│  Host OS  (issues logical writes)               │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│  Flash Translation Layer (FTL)                  │
│  ┌─────────────────────────────────────────┐    │
│  │  Wear-Leveling Algorithm                │    │
│  │  • Naive: sequential addressing         │    │
│  │  • Dynamic: min-wear-first allocation   │    │
│  │  • Static: periodic cold-data migration │    │
│  └─────────────────────────────────────────┘    │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│  NAND Flash Array  (N × N blocks)               │
└─────────────────────────────────────────────────┘
```

### Module Breakdown

| Module | Class | Purpose |
|--------|-------|---------|
| Memory Engine | `Block`, `SSDSimulator` | N×N block grid, P/E cycle tracking, statistics |
| WL Algorithms | `write_naive()`, `write_dynamic()`, `write_static()` | Three wear-leveling strategies |
| Visualization | `SSDDashboard` | Tkinter GUI, Matplotlib graph, interactive controls |

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).
