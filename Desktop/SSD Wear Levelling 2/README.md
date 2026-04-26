# SSD Wear-Leveling Simulator and Storage Evolution Visualizer

## Problem Statement
Solid-state drives (SSDs) use NAND flash memory, where each block has a limited number of write/erase cycles. Without proper management, heavily written blocks fail early, reducing reliability and lifespan. This project demonstrates how wear-leveling strategies and SSD controller techniques improve endurance and performance over older storage approaches.

## Project Overview
This is a complete front-end interactive simulator built with:
- HTML
- CSS
- JavaScript
- Chart.js for graphs

It runs locally in any modern browser by opening `index.html`.

## Major Features
- Virtual SSD model with configurable block count and endurance limit
- Three wear-leveling modes:
  - No Wear Leveling
  - Dynamic Wear Leveling
  - Static Wear Leveling
- Live block grid with wear-based color transitions and write animation
- Controls for start, pause, reset, speed, endurance, block count, and workload mode
- Real-time metrics dashboard:
  - Total writes
  - Average wear
  - Maximum wear
  - Wear variance
  - Failed blocks
  - Estimated SSD lifespan
- Side-by-side comparison mode (No WL vs Dynamic/Static)
- Advanced feature toggles:
  - Over-provisioning reserve blocks
  - Garbage collection
  - TRIM behavior
  - Bad block replacement
  - Flash Translation Layer (FTL) mapping
- Educational theory section explaining SSD wear and architecture
- Storage evolution module comparing HDD, basic flash systems, and modern SSDs
- Data visualization charts:
  - Wear distribution
  - Health histogram
  - Lifespan comparison
  - Algorithm performance radar
- Bonus features:
  - Export simulation results to JSON
  - Randomized workload generator
  - Sequential vs random vs hotspot workload modes
  - Research mode with advanced tuning parameters

## Algorithms Used
1. No Wear Leveling
- Repeated writes are concentrated in a limited hotspot set.
- Creates uneven wear and early failures.

2. Dynamic Wear Leveling
- Chooses least-worn available blocks for incoming writes.
- Balances wear for active data.

3. Static Wear Leveling
- Builds on dynamic policy.
- Periodically relocates static/cold data to include low-wear blocks in rotation.
- Improves long-term uniformity and endurance.

## Files
- `index.html` : app structure, controls, visual sections, educational modules
- `style.css` : responsive technical dashboard styling and animations
- `script.js` : simulation logic, UI controller, chart rendering, export support
- `README.md` : documentation

## How to Run
1. Download or clone the project folder.
2. Ensure all files are in the same directory:
   - `index.html`
   - `style.css`
   - `script.js`
3. Open `index.html` in a modern browser (Chrome/Edge/Firefox).
4. Use the Simulator Lab tab to run and compare wear-leveling methods.

## Suggested Demo Flow for Viva
1. Start with No Wear Leveling and hotspot workload.
2. Show rapid rise in failed blocks and high wear variance.
3. Reset and switch to Dynamic Wear Leveling.
4. Show improved wear spread and delayed failures.
5. Switch to Static Wear Leveling and discuss static-data relocation.
6. Enable advanced toggles (GC, TRIM, OP, bad block replacement) and compare.
7. Open comparison mode and run both sides simultaneously.
8. Use charts and theory/evolution tabs for conceptual explanation.

## Possible Future Improvements
- More realistic page-level NAND model (pages per block, ECC simulation)
- Queue-depth aware host workload model
- Read disturbance and retention error simulation
- Detailed FTL map visualization panel with animated mapping flow
- CSV export and report generation for experimental datasets
- Preset workloads based on enterprise, consumer, and embedded scenarios
