"""
╔══════════════════════════════════════════════════════════════════════════════╗
║                   SSD WEAR-LEVELING SIMULATOR                              ║
║  Demonstrates how SSD lifespans are extended by distributing writes        ║
║  across NAND flash blocks using different wear-leveling strategies.        ║
╚══════════════════════════════════════════════════════════════════════════════╝

Architecture Overview:
─────────────────────
In a real SSD, the Flash Translation Layer (FTL) sits between the host OS
and the raw NAND flash. The FTL is responsible for:
  1. Logical-to-Physical address mapping (so the OS sees a flat address space)
  2. Garbage Collection (reclaiming invalidated pages)
  3. Wear Leveling (distributing erases evenly across all blocks)

This simulator models the Wear Leveling component of the FTL, comparing
three strategies:
  • Naive (No WL)      – Sequential writes; hot blocks die early.
  • Dynamic WL         – Directs new writes to the least-worn free block.
  • Static WL          – Periodically swaps cold (static) data from low-wear
                         blocks into high-wear blocks, recycling low-wear
                         blocks back into the write pool.

Each "write" in this simulation represents a full block program/erase cycle.
A block is considered "dead" when it reaches max_erase_cycles.

Author: Auto-generated SSD Wear-Leveling Simulator
Dependencies: Python 3.8+, tkinter (built-in), matplotlib (pip install matplotlib)
"""

import tkinter as tk
from tkinter import ttk, messagebox
import random
import math
import threading
from collections import deque

# ──────────────────────────────────────────────────────────────────────────────
# Matplotlib backend setup – must be done BEFORE importing pyplot
# ──────────────────────────────────────────────────────────────────────────────
import matplotlib
matplotlib.use("TkAgg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import numpy as np


# ═══════════════════════════════════════════════════════════════════════════════
#  MODULE 1: MEMORY ENGINE (Backend)
# ═══════════════════════════════════════════════════════════════════════════════

class Block:
    """
    Represents a single NAND flash block in the SSD.
    
    In real NAND flash:
      - A block is the smallest erasable unit (typically 256KB–4MB).
      - Each block can sustain a limited number of program/erase (P/E) cycles
        before the oxide layer degrades and the block becomes unreliable.
      - SLC NAND: ~100,000 P/E cycles
      - MLC NAND: ~3,000–10,000 P/E cycles
      - TLC NAND: ~500–3,000 P/E cycles
    
    For simulation purposes, we use a configurable max_erase_cycles (default: 100).
    """
    __slots__ = ('row', 'col', 'write_count', 'data_type', 'is_alive',
                 'has_data', 'last_written_at')

    def __init__(self, row: int, col: int):
        self.row = row
        self.col = col
        self.write_count = 0          # Number of P/E cycles consumed
        self.data_type = "Empty"      # "Hot" (frequently written), "Cold" (rarely written), or "Empty"
        self.is_alive = True          # False once write_count >= max_erase_cycles
        self.has_data = False         # Whether block currently holds valid data
        self.last_written_at = 0      # Simulation tick of last write (for staleness detection)

    def reset(self):
        """Reset block to factory state (called when starting a new simulation)."""
        self.write_count = 0
        self.data_type = "Empty"
        self.is_alive = True
        self.has_data = False
        self.last_written_at = 0

    @property
    def wear_fraction(self) -> float:
        """Returns wear as a fraction [0.0, 1.0] of max erase cycles."""
        return self.write_count / SSDSimulator.MAX_ERASE_CYCLES

    def __repr__(self):
        status = "ALIVE" if self.is_alive else "DEAD"
        return f"Block({self.row},{self.col}) W={self.write_count} {self.data_type} {status}"


class SSDSimulator:
    """
    Core SSD simulation engine.
    
    FTL Architecture Modeled:
    ────────────────────────
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
    │  ┌─────────────────────────────────────────┐    │
    │  │  Logical → Physical Address Map         │    │
    │  └─────────────────────────────────────────┘    │
    └──────────────────┬──────────────────────────────┘
                       │
    ┌──────────────────▼──────────────────────────────┐
    │  NAND Flash Array  (N × N blocks)               │
    └─────────────────────────────────────────────────┘
    
    The simulator tracks per-block wear and reports statistics such as
    standard deviation of wear (lower = better leveling) and dead block count.
    """

    MAX_ERASE_CYCLES = 100  # P/E cycle limit before a block is considered dead

    def __init__(self, grid_size: int = 10):
        """
        Initialize the SSD with an N×N grid of flash blocks.
        
        Args:
            grid_size: Dimension N for the N×N block grid (total blocks = N²).
        """
        self.grid_size = grid_size
        self.total_blocks = grid_size * grid_size
        self.blocks: list[list[Block]] = []
        self.tick = 0                          # Global simulation clock
        self.naive_pointer = 0                 # Sequential pointer for Naive mode
        self.std_dev_history: list[float] = [] # Tracks wear std dev over time
        self.dead_block_history: list[int] = [] # Tracks dead blocks over time
        self._init_blocks()

    def _init_blocks(self):
        """Create the N×N grid of fresh blocks."""
        self.blocks = [
            [Block(r, c) for c in range(self.grid_size)]
            for r in range(self.grid_size)
        ]

    def reset(self):
        """Reset entire SSD to factory state."""
        self.tick = 0
        self.naive_pointer = 0
        self.std_dev_history.clear()
        self.dead_block_history.clear()
        for row in self.blocks:
            for block in row:
                block.reset()

    # ── Flat access helpers ──────────────────────────────────────────────────

    def _flat_blocks(self) -> list[Block]:
        """Return all blocks as a flat list (row-major order)."""
        return [block for row in self.blocks for block in row]

    def _block_at_index(self, idx: int) -> Block:
        """Get block by flat index."""
        r, c = divmod(idx, self.grid_size)
        return self.blocks[r][c]

    # ── Statistics ───────────────────────────────────────────────────────────

    def get_wear_std_dev(self) -> float:
        """
        Compute the standard deviation of write counts across ALL blocks.
        
        A lower value means writes are more evenly distributed,
        indicating better wear leveling.
        """
        counts = [b.write_count for b in self._flat_blocks()]
        mean = sum(counts) / len(counts)
        variance = sum((c - mean) ** 2 for c in counts) / len(counts)
        return math.sqrt(variance)

    def get_dead_block_count(self) -> int:
        """Count how many blocks have exceeded their P/E cycle limit."""
        return sum(1 for b in self._flat_blocks() if not b.is_alive)

    def get_alive_block_count(self) -> int:
        """Count blocks still within P/E cycle limits."""
        return sum(1 for b in self._flat_blocks() if b.is_alive)

    def get_avg_wear(self) -> float:
        """Average write count across all blocks."""
        counts = [b.write_count for b in self._flat_blocks()]
        return sum(counts) / len(counts) if counts else 0

    def get_max_wear(self) -> int:
        """Maximum write count among all blocks."""
        return max(b.write_count for b in self._flat_blocks())

    def get_min_wear(self) -> int:
        """Minimum write count among all blocks."""
        return min(b.write_count for b in self._flat_blocks())

    def record_snapshot(self):
        """Record current wear statistics for time-series plotting."""
        self.std_dev_history.append(self.get_wear_std_dev())
        self.dead_block_history.append(self.get_dead_block_count())

    # ══════════════════════════════════════════════════════════════════════════
    #  MODULE 2: WEAR-LEVELING ALGORITHMS
    # ══════════════════════════════════════════════════════════════════════════

    def _write_to_block(self, block: Block, data_type: str = "Hot"):
        """
        Simulate a program/erase cycle on a single block.
        
        In real NAND flash, writing involves:
          1. If the block contains stale data, ERASE the entire block first.
          2. PROGRAM new data into the erased block.
        Each erase increments the block's P/E cycle counter.
        
        Args:
            block: The target Block object.
            data_type: "Hot" for frequently-written data, "Cold" for static data.
        """
        if not block.is_alive:
            return  # Cannot write to a dead block

        block.write_count += 1
        block.data_type = data_type
        block.has_data = True
        block.last_written_at = self.tick

        # Check if block has reached end-of-life
        if block.write_count >= self.MAX_ERASE_CYCLES:
            block.is_alive = False
            block.data_type = "Dead"

    def write_naive(self):
        """
        NAIVE MODE (No Wear Leveling)
        ─────────────────────────────
        Simulates a simplistic FTL with NO wear-leveling logic.
        
        Strategy:
          - Maintain a sequential pointer into the logical address space.
          - For each write, advance the pointer and write to that block.
          - If the block is dead, skip to the next one.
        
        Problem:
          - The first blocks receive disproportionately more writes.
          - "Hot" data regions wear out quickly, causing early SSD failure
            even though many blocks remain unused.
        
        This is how early SSDs (and USB flash drives) worked before
        wear-leveling became standard in FTL firmware.
        """
        self.tick += 1

        # Scan for next alive block from current pointer position
        attempts = 0
        while attempts < self.total_blocks:
            block = self._block_at_index(self.naive_pointer % self.total_blocks)
            self.naive_pointer = (self.naive_pointer + 1) % self.total_blocks
            if block.is_alive:
                self._write_to_block(block, "Hot")
                return
            attempts += 1

        # All blocks dead – SSD is fully worn out

    def write_dynamic(self):
        """
        DYNAMIC WEAR LEVELING
        ─────────────────────
        Simulates the most common wear-leveling algorithm in modern SSDs.
        
        Strategy:
          - When the host issues a write, the FTL selects the BLOCK WITH
            THE LOWEST write_count among all alive blocks.
          - This ensures new writes are always directed to the freshest blocks.
        
        Advantage:
          - Greatly extends SSD lifespan for write-heavy workloads.
          - Simple to implement in firmware.
        
        Limitation:
          - If some blocks hold "cold" (rarely changed) data, they never get
            re-used, and their low wear is "wasted." Dynamic WL cannot
            reclaim these blocks because it only considers FREE blocks for
            new writes.
        
        This is the algorithm used by most consumer SSDs (e.g., Samsung EVO,
        Crucial MX series).
        """
        self.tick += 1

        alive_blocks = [b for b in self._flat_blocks() if b.is_alive]
        if not alive_blocks:
            return  # SSD fully worn out

        # FTL selects the block with minimum wear for the next write
        # This is the core of Dynamic Wear Leveling
        target = min(alive_blocks, key=lambda b: b.write_count)
        self._write_to_block(target, "Hot")

    def write_static(self):
        """
        STATIC WEAR LEVELING
        ────────────────────
        The most sophisticated wear-leveling strategy, used in enterprise SSDs.
        
        Strategy:
          1. For normal writes, behave like Dynamic WL (write to min-wear block).
          2. Periodically (every SWAP_INTERVAL writes), perform a COLD-DATA SWAP:
             - Find the block with the LOWEST wear that holds COLD data.
             - Find the block with the HIGHEST wear that is still alive.
             - SWAP their data: move cold data to the high-wear block,
               freeing the low-wear block for future hot writes.
        
        Rationale:
          In a real SSD, some data is written once and rarely modified
          (e.g., OS system files, installed programs). These "cold" blocks
          accumulate very low wear, while "hot" blocks (e.g., temp files,
          database journals) wear out quickly.
          
          Static WL solves this imbalance by forcibly migrating cold data,
          ensuring that ALL blocks participate in the wear pool, not just
          the ones receiving active writes.
        
        Trade-off:
          - Extra internal writes (write amplification) due to data migration.
          - More complex FTL firmware logic.
          - But significantly more even wear distribution → longer SSD life.
        
        This algorithm is found in enterprise SSDs like Intel DC S-series
        and Samsung PM/SM series.
        """
        self.tick += 1
        SWAP_INTERVAL = 10  # Perform cold-data swap every N writes

        alive_blocks = [b for b in self._flat_blocks() if b.is_alive]
        if not alive_blocks:
            return

        # ── Step 1: Normal write (Dynamic WL behavior) ───────────────────
        target = min(alive_blocks, key=lambda b: b.write_count)
        self._write_to_block(target, "Hot")

        # ── Step 2: Periodic cold-data migration ─────────────────────────
        # This is the distinguishing feature of Static Wear Leveling.
        # The FTL periodically relocates static data to redistribute wear.
        if self.tick % SWAP_INTERVAL == 0:
            self._perform_static_swap()

    def _perform_static_swap(self):
        """
        Cold-Data Swap Operation (Internal to the FTL)
        ───────────────────────────────────────────────
        1. Identify the least-worn block holding cold/static data.
        2. Identify the most-worn block that is still alive.
        3. Swap their data assignments.
        
        After the swap:
          - The previously cold (low-wear) block is now free for hot writes.
          - The high-wear block now holds cold data and won't be written again soon.
        
        This is analogous to what enterprise SSD controllers do during
        idle-time garbage collection and background wear leveling.
        """
        alive = [b for b in self._flat_blocks() if b.is_alive]
        if len(alive) < 2:
            return

        # Find blocks with cold data (data that hasn't been recently written)
        # A block is considered "cold" if it has data and was written
        # more than 20 ticks ago
        cold_threshold = self.tick - 20
        cold_blocks = [
            b for b in alive
            if b.has_data and b.last_written_at < cold_threshold
        ]

        if not cold_blocks:
            # No cold data found; mark oldest-data blocks as cold
            data_blocks = [b for b in alive if b.has_data]
            if data_blocks:
                # Sort by last_written_at ascending (oldest first)
                data_blocks.sort(key=lambda b: b.last_written_at)
                # Mark the oldest 20% as cold
                num_to_mark = max(1, len(data_blocks) // 5)
                for b in data_blocks[:num_to_mark]:
                    b.data_type = "Cold"
                cold_blocks = data_blocks[:num_to_mark]

        if not cold_blocks:
            return

        # Find the least-worn cold block and the most-worn alive block
        min_wear_cold = min(cold_blocks, key=lambda b: b.write_count)
        max_wear_alive = max(alive, key=lambda b: b.write_count)

        # Only swap if there's a meaningful wear differential
        # (avoid unnecessary write amplification)
        wear_diff = max_wear_alive.write_count - min_wear_cold.write_count
        if wear_diff > 5:
            # Simulate the data swap:
            # Move cold data from low-wear block → high-wear block
            # This costs one P/E cycle on each block (write amplification)
            max_wear_alive.data_type = "Cold"
            max_wear_alive.has_data = True

            # The low-wear block is now free for hot writes
            min_wear_cold.data_type = "Hot"
            min_wear_cold.has_data = False
            # Note: We don't increment write_count here since the "swap"
            # in our simplified model is just a logical reassignment.
            # In a real SSD, this would cost additional P/E cycles.


# ═══════════════════════════════════════════════════════════════════════════════
#  MODULE 3: VISUALIZATION (GUI / Dashboard)
# ═══════════════════════════════════════════════════════════════════════════════

class SSDDashboard:
    """
    Tkinter-based dashboard for visualizing SSD wear-leveling simulations.
    
    Layout:
    ┌──────────────────────────────────────────────────────────┐
    │  Title Bar                                               │
    ├──────────────┬───────────────────────────────────────────┤
    │  Controls    │   SSD Block Grid (N×N color-coded)       │
    │  • Algorithm │                                           │
    │  • Run Sim   │                                           │
    │  • Reset     ├───────────────────────────────────────────┤
    │  • Stats     │   Wear Std Dev Graph (Matplotlib)        │
    │              │                                           │
    ├──────────────┴───────────────────────────────────────────┤
    │  Summary Report / Status Bar                             │
    └──────────────────────────────────────────────────────────┘
    """

    # ── Theme Colors ─────────────────────────────────────────────────────────
    BG_DARK = "#0f0f1a"
    BG_PANEL = "#1a1a2e"
    BG_CARD = "#16213e"
    ACCENT_BLUE = "#0f3460"
    ACCENT_CYAN = "#00d2ff"
    ACCENT_PURPLE = "#7b2ff7"
    TEXT_PRIMARY = "#e0e0e0"
    TEXT_SECONDARY = "#8892a0"
    TEXT_HIGHLIGHT = "#00d2ff"
    BUTTON_BG = "#0f3460"
    BUTTON_HOVER = "#1a5276"
    BORDER_COLOR = "#2a2a4a"

    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("SSD Wear-Leveling Simulator")
        self.root.configure(bg=self.BG_DARK)
        self.root.minsize(1200, 780)

        # ── State ────────────────────────────────────────────────────────
        self.grid_size = 10
        self.simulator = SSDSimulator(self.grid_size)
        self.algorithm = tk.StringVar(value="naive")
        self.num_writes = tk.IntVar(value=1000)
        self.is_running = False
        self.animation_speed = tk.IntVar(value=50)  # writes per GUI update

        # ── Style Configuration ──────────────────────────────────────────
        self.style = ttk.Style()
        self.style.theme_use('clam')
        self._configure_styles()

        # ── Build UI ─────────────────────────────────────────────────────
        self._build_title_bar()
        self._build_main_layout()
        self._build_status_bar()
        self._update_grid_display()

    # ── Style Setup ──────────────────────────────────────────────────────────

    def _configure_styles(self):
        """Configure ttk styles for the dark theme."""
        self.style.configure("Dark.TFrame", background=self.BG_DARK)
        self.style.configure("Panel.TFrame", background=self.BG_PANEL)
        self.style.configure("Card.TFrame", background=self.BG_CARD)

        self.style.configure("Title.TLabel",
            background=self.BG_DARK, foreground=self.ACCENT_CYAN,
            font=("Segoe UI", 18, "bold"))
        self.style.configure("Subtitle.TLabel",
            background=self.BG_DARK, foreground=self.TEXT_SECONDARY,
            font=("Segoe UI", 10))
        self.style.configure("Heading.TLabel",
            background=self.BG_PANEL, foreground=self.TEXT_PRIMARY,
            font=("Segoe UI", 12, "bold"))
        self.style.configure("Body.TLabel",
            background=self.BG_PANEL, foreground=self.TEXT_PRIMARY,
            font=("Segoe UI", 10))
        self.style.configure("Stat.TLabel",
            background=self.BG_CARD, foreground=self.ACCENT_CYAN,
            font=("Consolas", 20, "bold"))
        self.style.configure("StatLabel.TLabel",
            background=self.BG_CARD, foreground=self.TEXT_SECONDARY,
            font=("Segoe UI", 9))
        self.style.configure("Info.TLabel",
            background=self.BG_PANEL, foreground=self.TEXT_SECONDARY,
            font=("Segoe UI", 9))
        self.style.configure("StatusBar.TLabel",
            background=self.BG_CARD, foreground=self.TEXT_SECONDARY,
            font=("Segoe UI", 9))

        # Radio buttons
        self.style.configure("Dark.TRadiobutton",
            background=self.BG_PANEL, foreground=self.TEXT_PRIMARY,
            font=("Segoe UI", 10), focuscolor=self.BG_PANEL)
        self.style.map("Dark.TRadiobutton",
            background=[("active", self.BG_PANEL)])

        # Separator
        self.style.configure("Dark.TSeparator", background=self.BORDER_COLOR)

    # ── Title Bar ────────────────────────────────────────────────────────────

    def _build_title_bar(self):
        """Build the top title bar with project name and description."""
        frame = ttk.Frame(self.root, style="Dark.TFrame")
        frame.pack(fill=tk.X, padx=20, pady=(15, 5))

        ttk.Label(frame, text="⚡ SSD Wear-Leveling Simulator",
                  style="Title.TLabel").pack(side=tk.LEFT)
        ttk.Label(frame,
                  text="Flash Translation Layer (FTL) Wear Distribution Analysis",
                  style="Subtitle.TLabel").pack(side=tk.RIGHT, pady=5)

    # ── Main Layout ──────────────────────────────────────────────────────────

    def _build_main_layout(self):
        """Build the main 2-column layout: controls (left) + visuals (right)."""
        main = ttk.Frame(self.root, style="Dark.TFrame")
        main.pack(fill=tk.BOTH, expand=True, padx=20, pady=10)

        # Left panel – controls
        left = ttk.Frame(main, style="Panel.TFrame", width=300)
        left.pack(side=tk.LEFT, fill=tk.Y, padx=(0, 10))
        left.pack_propagate(False)
        self._build_controls(left)

        # Right panel – visualizations
        right = ttk.Frame(main, style="Dark.TFrame")
        right.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self._build_visuals(right)

    # ── Control Panel ────────────────────────────────────────────────────────

    def _build_controls(self, parent):
        """Build the left-side control panel."""
        pad = {"padx": 15, "pady": 5}

        # ── Algorithm Selection ──────────────────────────────────────────
        ttk.Label(parent, text="ALGORITHM", style="Heading.TLabel").pack(
            anchor=tk.W, padx=15, pady=(15, 5))

        algorithms = [
            ("naive", "🚫  No Wear Leveling",
             "Sequential writes; blocks die early"),
            ("dynamic", "⚡  Dynamic WL",
             "Write to least-worn free block"),
            ("static", "🔄  Static WL",
             "Dynamic + periodic cold-data swap"),
        ]
        for value, label, desc in algorithms:
            f = ttk.Frame(parent, style="Panel.TFrame")
            f.pack(fill=tk.X, padx=15, pady=2)
            rb = ttk.Radiobutton(f, text=label, variable=self.algorithm,
                                 value=value, style="Dark.TRadiobutton")
            rb.pack(anchor=tk.W)
            ttk.Label(f, text=f"  {desc}", style="Info.TLabel").pack(
                anchor=tk.W, padx=(20, 0))

        # ── Separator ───────────────────────────────────────────────────
        ttk.Separator(parent, orient=tk.HORIZONTAL,
                      style="Dark.TSeparator").pack(fill=tk.X, padx=15, pady=10)

        # ── Simulation Parameters ────────────────────────────────────────
        ttk.Label(parent, text="PARAMETERS", style="Heading.TLabel").pack(
            anchor=tk.W, **pad)

        pf = ttk.Frame(parent, style="Panel.TFrame")
        pf.pack(fill=tk.X, **pad)
        ttk.Label(pf, text="Number of Writes:", style="Body.TLabel").pack(
            anchor=tk.W)
        writes_entry = tk.Entry(pf, textvariable=self.num_writes,
            font=("Consolas", 11), bg=self.BG_CARD, fg=self.ACCENT_CYAN,
            insertbackground=self.ACCENT_CYAN, relief=tk.FLAT,
            highlightthickness=1, highlightcolor=self.ACCENT_BLUE,
            highlightbackground=self.BORDER_COLOR)
        writes_entry.pack(fill=tk.X, pady=(3, 0))

        sf = ttk.Frame(parent, style="Panel.TFrame")
        sf.pack(fill=tk.X, **pad)
        ttk.Label(sf, text=f"Grid Size: {self.grid_size}×{self.grid_size}  "
                  f"({self.grid_size**2} blocks)", style="Body.TLabel").pack(
            anchor=tk.W)
        ttk.Label(sf, text=f"Max P/E Cycles: {SSDSimulator.MAX_ERASE_CYCLES}",
                  style="Body.TLabel").pack(anchor=tk.W)

        # ── Separator ───────────────────────────────────────────────────
        ttk.Separator(parent, orient=tk.HORIZONTAL,
                      style="Dark.TSeparator").pack(fill=tk.X, padx=15, pady=10)

        # ── Action Buttons ───────────────────────────────────────────────
        ttk.Label(parent, text="ACTIONS", style="Heading.TLabel").pack(
            anchor=tk.W, **pad)

        self.run_btn = tk.Button(parent, text="▶  RUN SIMULATION",
            font=("Segoe UI", 11, "bold"), bg="#00875a", fg="white",
            activebackground="#00a86b", activeforeground="white",
            relief=tk.FLAT, cursor="hand2", height=2,
            command=self._run_simulation)
        self.run_btn.pack(fill=tk.X, padx=15, pady=(5, 3))

        self.reset_btn = tk.Button(parent, text="↺  RESET",
            font=("Segoe UI", 10), bg=self.ACCENT_BLUE, fg="white",
            activebackground=self.BUTTON_HOVER, activeforeground="white",
            relief=tk.FLAT, cursor="hand2",
            command=self._reset_simulation)
        self.reset_btn.pack(fill=tk.X, padx=15, pady=3)

        # ── Separator ───────────────────────────────────────────────────
        ttk.Separator(parent, orient=tk.HORIZONTAL,
                      style="Dark.TSeparator").pack(fill=tk.X, padx=15, pady=10)

        # ── Live Stats ───────────────────────────────────────────────────
        ttk.Label(parent, text="LIVE STATISTICS", style="Heading.TLabel").pack(
            anchor=tk.W, **pad)

        stats_grid = ttk.Frame(parent, style="Panel.TFrame")
        stats_grid.pack(fill=tk.X, **pad)

        self.stat_labels = {}
        stat_defs = [
            ("dead", "Dead Blocks", "0"),
            ("alive", "Alive Blocks", str(self.grid_size**2)),
            ("stddev", "Wear Std Dev", "0.00"),
            ("avg", "Avg Wear", "0.00"),
            ("max", "Max Wear", "0"),
            ("min", "Min Wear", "0"),
        ]
        for i, (key, label, default) in enumerate(stat_defs):
            card = ttk.Frame(stats_grid, style="Card.TFrame")
            card.grid(row=i // 2, column=i % 2, padx=3, pady=3, sticky="nsew")
            stats_grid.columnconfigure(i % 2, weight=1)

            val_lbl = ttk.Label(card, text=default, style="Stat.TLabel")
            val_lbl.pack(padx=8, pady=(6, 0))
            ttk.Label(card, text=label, style="StatLabel.TLabel").pack(
                padx=8, pady=(0, 6))
            self.stat_labels[key] = val_lbl

        # ── Legend ───────────────────────────────────────────────────────
        ttk.Separator(parent, orient=tk.HORIZONTAL,
                      style="Dark.TSeparator").pack(fill=tk.X, padx=15, pady=10)
        ttk.Label(parent, text="LEGEND", style="Heading.TLabel").pack(
            anchor=tk.W, **pad)

        legend_frame = ttk.Frame(parent, style="Panel.TFrame")
        legend_frame.pack(fill=tk.X, **pad)

        legends = [
            ("#2ecc71", "0% wear (Fresh)"),
            ("#f1c40f", "~50% wear"),
            ("#e74c3c", "~90% wear"),
            ("#1a1a2e", "100% wear (Dead)"),
        ]
        for color, text in legends:
            row = ttk.Frame(legend_frame, style="Panel.TFrame")
            row.pack(fill=tk.X, pady=1)
            swatch = tk.Canvas(row, width=14, height=14, bg=self.BG_PANEL,
                               highlightthickness=0)
            swatch.create_rectangle(1, 1, 13, 13, fill=color, outline="")
            swatch.pack(side=tk.LEFT, padx=(0, 8))
            ttk.Label(row, text=text, style="Info.TLabel").pack(
                side=tk.LEFT)

    # ── Visualization Panel ──────────────────────────────────────────────────

    def _build_visuals(self, parent):
        """Build the right-side visualization panel (grid + graph)."""
        # ── Top: SSD Block Grid ──────────────────────────────────────────
        grid_frame = ttk.Frame(parent, style="Panel.TFrame")
        grid_frame.pack(fill=tk.BOTH, expand=True, pady=(0, 10))

        header = ttk.Frame(grid_frame, style="Panel.TFrame")
        header.pack(fill=tk.X, padx=15, pady=(10, 5))
        ttk.Label(header, text="NAND FLASH BLOCK ARRAY",
                  style="Heading.TLabel").pack(side=tk.LEFT)
        self.grid_info_label = ttk.Label(header, text="All blocks fresh",
                                         style="Info.TLabel")
        self.grid_info_label.pack(side=tk.RIGHT)

        # Canvas for the block grid
        canvas_container = ttk.Frame(grid_frame, style="Panel.TFrame")
        canvas_container.pack(fill=tk.BOTH, expand=True, padx=15, pady=(0, 10))

        self.grid_canvas = tk.Canvas(canvas_container, bg=self.BG_DARK,
                                      highlightthickness=0)
        self.grid_canvas.pack(fill=tk.BOTH, expand=True)
        self.block_rects = {}  # (row, col) -> canvas rectangle ID
        self.block_texts = {}  # (row, col) -> canvas text ID

        # ── Bottom: Matplotlib Graph ─────────────────────────────────────
        graph_frame = ttk.Frame(parent, style="Panel.TFrame")
        graph_frame.pack(fill=tk.BOTH, expand=True)

        header2 = ttk.Frame(graph_frame, style="Panel.TFrame")
        header2.pack(fill=tk.X, padx=15, pady=(10, 0))
        ttk.Label(header2, text="WEAR DISTRIBUTION ANALYSIS",
                  style="Heading.TLabel").pack(side=tk.LEFT)

        self.fig, self.ax = plt.subplots(1, 1, figsize=(8, 2.5))
        self.fig.patch.set_facecolor(self.BG_PANEL)
        self.ax.set_facecolor(self.BG_DARK)
        self.ax.tick_params(colors=self.TEXT_SECONDARY, labelsize=8)
        self.ax.spines['bottom'].set_color(self.BORDER_COLOR)
        self.ax.spines['left'].set_color(self.BORDER_COLOR)
        self.ax.spines['top'].set_visible(False)
        self.ax.spines['right'].set_visible(False)
        self.ax.set_xlabel("Write Operations", color=self.TEXT_SECONDARY,
                           fontsize=9)
        self.ax.set_ylabel("Wear Std Dev", color=self.TEXT_SECONDARY,
                           fontsize=9)
        self.ax.set_title("Standard Deviation of Block Wear Over Time",
                          color=self.TEXT_PRIMARY, fontsize=10, pad=8)

        self.canvas_widget = FigureCanvasTkAgg(self.fig, master=graph_frame)
        self.canvas_widget.get_tk_widget().pack(fill=tk.BOTH, expand=True,
                                                 padx=15, pady=(5, 10))

        # Draw initial empty grid
        self.root.update_idletasks()
        self._draw_grid()

    # ── Grid Drawing ─────────────────────────────────────────────────────────

    def _get_wear_color(self, block: Block) -> str:
        """
        Map block wear to a color gradient:
          0%   wear → Bright Green  (#2ecc71)
          50%  wear → Yellow        (#f1c40f)
          100% wear → Red           (#e74c3c)
          Dead       → Dark          (#1a1a2e)
        """
        if not block.is_alive:
            return "#1a1a2e"  # Dead block – very dark

        fraction = block.wear_fraction

        if fraction <= 0.5:
            # Green → Yellow gradient
            t = fraction / 0.5
            r = int(46 + (241 - 46) * t)
            g = int(204 + (196 - 204) * t)
            b = int(113 + (15 - 113) * t)
        else:
            # Yellow → Red gradient
            t = (fraction - 0.5) / 0.5
            r = int(241 + (231 - 241) * t)
            g = int(196 - 196 * t)
            b = int(15 + (60 - 15) * t)

        return f"#{r:02x}{g:02x}{b:02x}"

    def _draw_grid(self):
        """Draw or update the N×N block grid on the canvas."""
        self.grid_canvas.delete("all")
        self.block_rects.clear()
        self.block_texts.clear()

        canvas_w = self.grid_canvas.winfo_width()
        canvas_h = self.grid_canvas.winfo_height()

        if canvas_w < 50 or canvas_h < 50:
            # Canvas not yet laid out; schedule redraw
            self.root.after(100, self._draw_grid)
            return

        padding = 10
        gap = 2
        available_w = canvas_w - 2 * padding
        available_h = canvas_h - 2 * padding
        cell_size = min(
            (available_w - gap * (self.grid_size - 1)) // self.grid_size,
            (available_h - gap * (self.grid_size - 1)) // self.grid_size
        )
        cell_size = max(cell_size, 8)  # minimum size

        # Center the grid
        total_w = self.grid_size * cell_size + (self.grid_size - 1) * gap
        total_h = self.grid_size * cell_size + (self.grid_size - 1) * gap
        offset_x = (canvas_w - total_w) // 2
        offset_y = (canvas_h - total_h) // 2

        for r in range(self.grid_size):
            for c in range(self.grid_size):
                block = self.simulator.blocks[r][c]
                x1 = offset_x + c * (cell_size + gap)
                y1 = offset_y + r * (cell_size + gap)
                x2 = x1 + cell_size
                y2 = y1 + cell_size

                color = self._get_wear_color(block)

                rect_id = self.grid_canvas.create_rectangle(
                    x1, y1, x2, y2, fill=color, outline="#2a2a4a", width=1
                )
                self.block_rects[(r, c)] = rect_id

                # Show write count on each cell if cells are large enough
                if cell_size >= 28:
                    text_color = "#000000" if block.wear_fraction < 0.7 else "#ffffff"
                    if not block.is_alive:
                        text_color = "#555555"
                    txt_id = self.grid_canvas.create_text(
                        (x1 + x2) // 2, (y1 + y2) // 2,
                        text=str(block.write_count),
                        fill=text_color,
                        font=("Consolas", max(7, cell_size // 4))
                    )
                    self.block_texts[(r, c)] = txt_id

                # Tooltip on hover
                self.grid_canvas.tag_bind(rect_id, "<Enter>",
                    lambda e, b=block: self._show_block_tooltip(e, b))
                self.grid_canvas.tag_bind(rect_id, "<Leave>",
                    lambda e: self._hide_tooltip())

    def _update_grid_display(self):
        """Update colors and text on existing grid rectangles."""
        for r in range(self.grid_size):
            for c in range(self.grid_size):
                block = self.simulator.blocks[r][c]
                color = self._get_wear_color(block)

                if (r, c) in self.block_rects:
                    self.grid_canvas.itemconfig(self.block_rects[(r, c)],
                                                 fill=color)
                if (r, c) in self.block_texts:
                    text_color = "#000000" if block.wear_fraction < 0.7 else "#ffffff"
                    if not block.is_alive:
                        text_color = "#555555"
                    self.grid_canvas.itemconfig(self.block_texts[(r, c)],
                                                 text=str(block.write_count),
                                                 fill=text_color)

        # Update stats
        dead = self.simulator.get_dead_block_count()
        alive = self.simulator.get_alive_block_count()
        stddev = self.simulator.get_wear_std_dev()
        avg = self.simulator.get_avg_wear()
        max_w = self.simulator.get_max_wear()
        min_w = self.simulator.get_min_wear()

        self.stat_labels["dead"].config(text=str(dead))
        self.stat_labels["alive"].config(text=str(alive))
        self.stat_labels["stddev"].config(text=f"{stddev:.2f}")
        self.stat_labels["avg"].config(text=f"{avg:.1f}")
        self.stat_labels["max"].config(text=str(max_w))
        self.stat_labels["min"].config(text=str(min_w))

        # Update grid info
        self.grid_info_label.config(
            text=f"Tick: {self.simulator.tick}  |  "
                 f"Dead: {dead}/{self.simulator.total_blocks}")

    # ── Tooltip ──────────────────────────────────────────────────────────────

    def _show_block_tooltip(self, event, block: Block):
        """Show a tooltip with block details on hover."""
        self._hide_tooltip()
        tip = tk.Toplevel(self.root)
        tip.wm_overrideredirect(True)
        tip.wm_geometry(f"+{event.x_root + 15}+{event.y_root + 10}")
        tip.configure(bg=self.BG_CARD)

        status = "🟢 ALIVE" if block.is_alive else "💀 DEAD"
        wear_pct = f"{block.wear_fraction * 100:.1f}%"

        text = (f"Block ({block.row}, {block.col})\n"
                f"Status: {status}\n"
                f"Writes: {block.write_count} / {SSDSimulator.MAX_ERASE_CYCLES}\n"
                f"Wear: {wear_pct}\n"
                f"Data: {block.data_type}")

        lbl = tk.Label(tip, text=text, bg=self.BG_CARD, fg=self.TEXT_PRIMARY,
                       font=("Consolas", 9), justify=tk.LEFT,
                       padx=10, pady=6)
        lbl.pack()
        self._tooltip = tip

    def _hide_tooltip(self):
        """Destroy any existing tooltip."""
        if hasattr(self, '_tooltip') and self._tooltip:
            self._tooltip.destroy()
            self._tooltip = None

    # ── Graph Update ─────────────────────────────────────────────────────────

    def _update_graph(self):
        """Redraw the matplotlib wear std dev graph."""
        self.ax.clear()
        self.ax.set_facecolor(self.BG_DARK)
        self.ax.tick_params(colors=self.TEXT_SECONDARY, labelsize=8)
        self.ax.spines['bottom'].set_color(self.BORDER_COLOR)
        self.ax.spines['left'].set_color(self.BORDER_COLOR)
        self.ax.spines['top'].set_visible(False)
        self.ax.spines['right'].set_visible(False)

        if self.simulator.std_dev_history:
            x = list(range(len(self.simulator.std_dev_history)))
            y = self.simulator.std_dev_history

            # Main line with gradient fill
            self.ax.plot(x, y, color=self.ACCENT_CYAN, linewidth=1.5,
                        alpha=0.9, label="Wear Std Dev")
            self.ax.fill_between(x, y, alpha=0.15, color=self.ACCENT_CYAN)

            # Mark current value
            if len(y) > 0:
                self.ax.annotate(f"{y[-1]:.2f}",
                    xy=(x[-1], y[-1]),
                    xytext=(10, 10), textcoords='offset points',
                    color=self.ACCENT_CYAN, fontsize=9, fontweight='bold',
                    arrowprops=dict(arrowstyle='->', color=self.ACCENT_CYAN,
                                   lw=0.8))

        self.ax.set_xlabel("Snapshot (every 10 writes)", color=self.TEXT_SECONDARY,
                           fontsize=9)
        self.ax.set_ylabel("Wear Std Dev", color=self.TEXT_SECONDARY, fontsize=9)

        algo_names = {
            "naive": "No Wear Leveling",
            "dynamic": "Dynamic WL",
            "static": "Static WL"
        }
        algo_name = algo_names.get(self.algorithm.get(), "Unknown")
        self.ax.set_title(
            f"Wear Distribution — {algo_name}",
            color=self.TEXT_PRIMARY, fontsize=10, pad=8)

        self.ax.legend(loc='upper left', fontsize=8,
                      facecolor=self.BG_CARD, edgecolor=self.BORDER_COLOR,
                      labelcolor=self.TEXT_PRIMARY)

        self.fig.tight_layout()
        self.canvas_widget.draw()

    # ── Status Bar ───────────────────────────────────────────────────────────

    def _build_status_bar(self):
        """Build the bottom status bar."""
        bar = ttk.Frame(self.root, style="Card.TFrame")
        bar.pack(fill=tk.X, padx=20, pady=(0, 10))

        self.status_label = ttk.Label(bar,
            text="Ready — Select an algorithm and click 'Run Simulation'",
            style="StatusBar.TLabel")
        self.status_label.pack(side=tk.LEFT, padx=15, pady=8)

        self.progress_var = tk.DoubleVar(value=0)
        self.progress_bar = ttk.Progressbar(bar, variable=self.progress_var,
                                             maximum=100, length=200)
        self.progress_bar.pack(side=tk.RIGHT, padx=15, pady=8)

    # ══════════════════════════════════════════════════════════════════════════
    #  SIMULATION CONTROL
    # ══════════════════════════════════════════════════════════════════════════

    def _run_simulation(self):
        """Start the simulation in a background-friendly manner using tkinter after()."""
        if self.is_running:
            return

        num_writes = self.num_writes.get()
        if num_writes <= 0:
            messagebox.showwarning("Invalid Input",
                                   "Number of writes must be positive.")
            return

        self.is_running = True
        self.run_btn.config(state=tk.DISABLED, bg="#555555")
        self.reset_btn.config(state=tk.DISABLED)

        algo = self.algorithm.get()
        algo_names = {"naive": "No Wear Leveling", "dynamic": "Dynamic WL",
                      "static": "Static WL"}

        self.status_label.config(
            text=f"Running {algo_names[algo]}... 0/{num_writes} writes")

        # Select the write function based on algorithm choice
        write_fn = {
            "naive": self.simulator.write_naive,
            "dynamic": self.simulator.write_dynamic,
            "static": self.simulator.write_static,
        }[algo]

        # Use tkinter's after() for non-blocking animation
        self._sim_state = {
            "write_fn": write_fn,
            "total": num_writes,
            "done": 0,
            "batch_size": max(1, self.animation_speed.get()),
            "algo_name": algo_names[algo],
            "snapshot_interval": max(1, num_writes // 100),
        }
        self._sim_step()

    def _sim_step(self):
        """Execute one batch of writes, then schedule the next batch."""
        state = self._sim_state
        batch = min(state["batch_size"], state["total"] - state["done"])

        for _ in range(batch):
            # Check if all blocks are dead before writing
            if self.simulator.get_alive_block_count() == 0:
                state["done"] = state["total"]  # Force completion
                break

            state["write_fn"]()
            state["done"] += 1

            # Record snapshot periodically for the graph
            if state["done"] % state["snapshot_interval"] == 0:
                self.simulator.record_snapshot()

        # Update progress
        progress = (state["done"] / state["total"]) * 100
        self.progress_var.set(progress)
        self.status_label.config(
            text=f"Running {state['algo_name']}... "
                 f"{state['done']}/{state['total']} writes")

        # Update visuals
        self._update_grid_display()

        if state["done"] < state["total"]:
            # Schedule next batch (33ms ≈ 30fps feel)
            self.root.after(33, self._sim_step)
        else:
            # Simulation complete
            self.simulator.record_snapshot()  # Final snapshot
            self._update_graph()
            self._update_grid_display()
            self._show_summary_report()
            self.is_running = False
            self.run_btn.config(state=tk.NORMAL, bg="#00875a")
            self.reset_btn.config(state=tk.NORMAL)

    def _reset_simulation(self):
        """Reset the simulator and all visuals to initial state."""
        if self.is_running:
            return

        self.simulator.reset()
        self.progress_var.set(0)
        self.status_label.config(
            text="Ready — Select an algorithm and click 'Run Simulation'")

        # Redraw grid from scratch (in case window was resized)
        self._draw_grid()
        self._update_grid_display()

        # Clear graph
        self.ax.clear()
        self.ax.set_facecolor(self.BG_DARK)
        self.ax.tick_params(colors=self.TEXT_SECONDARY, labelsize=8)
        self.ax.spines['bottom'].set_color(self.BORDER_COLOR)
        self.ax.spines['left'].set_color(self.BORDER_COLOR)
        self.ax.spines['top'].set_visible(False)
        self.ax.spines['right'].set_visible(False)
        self.ax.set_xlabel("Write Operations", color=self.TEXT_SECONDARY,
                           fontsize=9)
        self.ax.set_ylabel("Wear Std Dev", color=self.TEXT_SECONDARY,
                           fontsize=9)
        self.ax.set_title("Standard Deviation of Block Wear Over Time",
                          color=self.TEXT_PRIMARY, fontsize=10, pad=8)
        self.fig.tight_layout()
        self.canvas_widget.draw()

    def _show_summary_report(self):
        """
        Display a summary report after simulation completes.
        
        The report shows key metrics that demonstrate the effectiveness
        (or lack thereof) of the selected wear-leveling algorithm.
        """
        dead = self.simulator.get_dead_block_count()
        alive = self.simulator.get_alive_block_count()
        stddev = self.simulator.get_wear_std_dev()
        avg = self.simulator.get_avg_wear()
        max_w = self.simulator.get_max_wear()
        min_w = self.simulator.get_min_wear()
        total = self.simulator.total_blocks

        algo_names = {"naive": "No Wear Leveling", "dynamic": "Dynamic WL",
                      "static": "Static WL"}
        algo = algo_names.get(self.algorithm.get(), "Unknown")

        # Build the report
        report = f"""
╔══════════════════════════════════════════════════╗
║           SIMULATION SUMMARY REPORT              ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  Algorithm:     {algo:<33s}║
║  Total Writes:  {self.num_writes.get():<33d}║
║  Grid Size:     {self.grid_size}×{self.grid_size} ({total} blocks){' ' * (24 - len(str(total)))}║
║  Max P/E:       {SSDSimulator.MAX_ERASE_CYCLES:<33d}║
║                                                  ║
╠══════════════════════════════════════════════════╣
║  RESULTS                                         ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  Dead Blocks:   {dead}/{total} ({dead/total*100:.1f}%){' ' * max(0, 25 - len(f'{dead}/{total} ({dead/total*100:.1f}%)'))}║
║  Alive Blocks:  {alive}/{total} ({alive/total*100:.1f}%){' ' * max(0, 24 - len(f'{alive}/{total} ({alive/total*100:.1f}%)'))}║
║  Avg Wear:      {avg:.2f} cycles{' ' * max(0, 27 - len(f'{avg:.2f} cycles'))}║
║  Max Wear:      {max_w} cycles{' ' * max(0, 29 - len(f'{max_w} cycles'))}║
║  Min Wear:      {min_w} cycles{' ' * max(0, 29 - len(f'{min_w} cycles'))}║
║  Wear Std Dev:  {stddev:.4f}{' ' * max(0, 30 - len(f'{stddev:.4f}'))}║
║                                                  ║
╠══════════════════════════════════════════════════╣
║  INTERPRETATION                                  ║
╠══════════════════════════════════════════════════╣"""

        if self.algorithm.get() == "naive":
            report += """
║                                                  ║
║  ⚠️  NO WEAR LEVELING causes concentrated wear   ║
║  on a small subset of blocks, killing them early  ║
║  while leaving others barely used. This is the    ║
║  worst-case scenario for SSD longevity.           ║
║                                                  ║"""
        elif self.algorithm.get() == "dynamic":
            report += """
║                                                  ║
║  ⚡ DYNAMIC WL distributes writes across free     ║
║  blocks effectively, reducing hotspot wear.       ║
║  However, blocks holding cold data may never      ║
║  participate in the write pool.                   ║
║                                                  ║"""
        else:
            report += """
║                                                  ║
║  🔄 STATIC WL achieves the most even wear by      ║
║  periodically migrating cold data, ensuring ALL   ║
║  blocks participate in the write pool. This is    ║
║  the gold standard for SSD longevity.             ║
║                                                  ║"""

        report += """
╚══════════════════════════════════════════════════╝"""

        # Show in a popup window
        popup = tk.Toplevel(self.root)
        popup.title("Simulation Summary Report")
        popup.configure(bg=self.BG_DARK)
        popup.geometry("520x580")
        popup.resizable(False, False)

        text_widget = tk.Text(popup, wrap=tk.NONE,
            bg=self.BG_DARK, fg=self.ACCENT_CYAN,
            font=("Consolas", 10), relief=tk.FLAT,
            padx=20, pady=15, highlightthickness=0)
        text_widget.insert("1.0", report)
        text_widget.config(state=tk.DISABLED)
        text_widget.pack(fill=tk.BOTH, expand=True)

        close_btn = tk.Button(popup, text="Close", font=("Segoe UI", 10),
            bg=self.ACCENT_BLUE, fg="white", relief=tk.FLAT,
            command=popup.destroy, cursor="hand2")
        close_btn.pack(pady=(0, 15))

        self.status_label.config(
            text=f"✅ Simulation complete — {algo} — "
                 f"{dead} dead blocks, σ = {stddev:.4f}")


# ═══════════════════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    """Launch the SSD Wear-Leveling Simulator dashboard."""
    root = tk.Tk()

    # Set DPI awareness for crisp rendering on HiDPI displays (Windows)
    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass

    # Center window on screen
    screen_w = root.winfo_screenwidth()
    screen_h = root.winfo_screenheight()
    win_w, win_h = 1280, 800
    x = (screen_w - win_w) // 2
    y = (screen_h - win_h) // 2
    root.geometry(f"{win_w}x{win_h}+{x}+{y}")

    app = SSDDashboard(root)

    # Handle window resize — redraw grid
    def on_resize(event):
        if not app.is_running:
            app._draw_grid()
            app._update_grid_display()
    root.bind("<Configure>", lambda e: root.after_cancel(
        getattr(root, '_resize_id', None)) if hasattr(root, '_resize_id')
        else None)

    def debounced_resize(event):
        if hasattr(root, '_resize_id'):
            root.after_cancel(root._resize_id)
        root._resize_id = root.after(200, lambda: on_resize(event))
    root.bind("<Configure>", debounced_resize)

    root.mainloop()


if __name__ == "__main__":
    main()
