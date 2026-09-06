const WEAR_COLORS = {
  healthy: "#58d68d",
  moderate: "#f7dc6f",
  high: "#f39c4c",
  nearFailure: "#ff6d5f",
  failed: "#4a4f59",
  reserve: "#266b7b"
};

class SSDModel {
  constructor(config) {
    this.configure(config);
  }

  configure(config) {
    this.blockCount = config.blockCount;
    this.endurance = config.endurance;
    this.algorithm = config.algorithm;
    this.workload = config.workload;
    this.features = { ...config.features };
    this.staticMoveInterval = config.staticMoveInterval;
    this.hotsetRatio = config.hotsetRatio;
    this.gcThreshold = config.gcThreshold;
    this.reserveRatio = config.reserveRatio;
    this.reset();
  }

  reset() {
    this.time = 0;
    this.totalWrites = 0;
    this.failedBlocks = 0;
    this.lastWrittenBlockId = null;
    this.sequentialPtr = 0;
    this.logicalWritePtr = 0;
    this.lastHotsetStart = 0;
    this.relocations = 0;

    const reserveCount = this.features.overProvisioning
      ? Math.max(1, Math.floor(this.blockCount * (this.reserveRatio / 100)))
      : 0;

    this.blocks = [];
    for (let i = 0; i < this.blockCount; i += 1) {
      this.blocks.push({
        id: i,
        wear: 0,
        writes: 0,
        erases: 0,
        invalidPages: 0,
        failed: false,
        health: 100,
        isReserve: i >= this.blockCount - reserveCount,
        hasStaticData: false,
        logicalAddress: null
      });
    }

    this.logicalToPhysical = {};
    this.failedHistory = [];
    this.writeHistory = [];
    this.ftlMoves = [];

    this.seedStaticData();
  }

  seedStaticData() {
    const activeBlocks = this.getActiveBlocks(false);
    const staticCount = Math.max(2, Math.floor(activeBlocks.length * 0.1));
    for (let i = 0; i < staticCount; i += 1) {
      const block = activeBlocks[i];
      block.hasStaticData = true;
      block.logicalAddress = `S${i}`;
    }
  }

  getActiveBlocks(includeReserve = false) {
    return this.blocks.filter((b) => !b.failed && (includeReserve || !b.isReserve));
  }

  getBlockStateByWear(block) {
    if (block.failed) {
      return "failed";
    }
    if (block.isReserve && block.wear === 0 && !block.logicalAddress) {
      return "reserve";
    }
    const ratio = block.wear / this.endurance;
    if (ratio < 0.3) {
      return "healthy";
    }
    if (ratio < 0.6) {
      return "moderate";
    }
    if (ratio < 0.85) {
      return "high";
    }
    return "nearFailure";
  }

  markBlockWear(block, amount = 1) {
    if (block.failed) {
      return;
    }

    block.wear += amount;
    block.writes += 1;
    block.erases += amount > 1 ? 1 : 0;
    block.health = Math.max(0, 100 - (block.wear / this.endurance) * 100);

    if (block.wear >= this.endurance) {
      block.failed = true;
      block.health = 0;
      this.failedBlocks += 1;
      this.failedHistory.push({ time: this.time, blockId: block.id });

      if (this.features.badBlockReplacement) {
        this.replaceFailedBlock(block);
      }
    }
  }

  replaceFailedBlock(failedBlock) {
    const candidate = this.blocks.find(
      (b) => b.isReserve && !b.failed && b.logicalAddress === null && b.wear < this.endurance
    );
    if (!candidate) {
      return;
    }

    candidate.isReserve = false;
    candidate.logicalAddress = failedBlock.logicalAddress;
    candidate.hasStaticData = failedBlock.hasStaticData;

    if (failedBlock.logicalAddress !== null) {
      this.logicalToPhysical[failedBlock.logicalAddress] = candidate.id;
    }
  }

  pickLogicalAddress() {
    if (this.workload === "sequential") {
      const lba = this.logicalWritePtr;
      this.logicalWritePtr = (this.logicalWritePtr + 1) % Math.max(8, Math.floor(this.blockCount * 0.75));
      return lba;
    }

    if (this.workload === "hotspot") {
      const hotsetSize = Math.max(4, Math.floor(this.blockCount * (this.hotsetRatio / 100)));
      if (this.time % 300 === 0) {
        this.lastHotsetStart = Math.floor(Math.random() * Math.max(1, this.blockCount - hotsetSize));
      }
      return this.lastHotsetStart + Math.floor(Math.random() * hotsetSize);
    }

    return Math.floor(Math.random() * Math.max(8, Math.floor(this.blockCount * 0.8)));
  }

  chooseTargetBlock(logicalAddress) {
    const writable = this.getActiveBlocks(false).filter((b) => !b.hasStaticData || this.algorithm === "static");

    if (!writable.length) {
      return null;
    }

    if (this.algorithm === "none") {
      const hotspotLength = Math.max(4, Math.floor(writable.length * 0.12));
      return writable[(logicalAddress + this.time) % hotspotLength];
    }

    const sortedByWear = [...writable].sort((a, b) => a.wear - b.wear);

    if (this.algorithm === "dynamic") {
      return sortedByWear[0];
    }

    if (this.algorithm === "static") {
      return sortedByWear[0];
    }

    return writable[0];
  }

  maybeRunTrim(previousPhysicalId) {
    if (!this.features.trim || previousPhysicalId === undefined) {
      return;
    }
    const oldBlock = this.blocks[previousPhysicalId];
    if (!oldBlock || oldBlock.failed) {
      return;
    }
    oldBlock.invalidPages += 1;
  }

  maybeRunGarbageCollection() {
    if (!this.features.garbageCollection) {
      return;
    }

    const gcCandidates = this.blocks
      .filter((b) => !b.failed && !b.isReserve)
      .sort((a, b) => b.invalidPages - a.invalidPages);

    const target = gcCandidates[0];
    if (!target) {
      return;
    }

    const thresholdPages = Math.max(2, Math.floor(this.gcThreshold / 10));
    if (target.invalidPages < thresholdPages) {
      return;
    }

    target.invalidPages = 0;
    this.markBlockWear(target, 2);
  }

  maybeRunStaticRelocation() {
    if (this.algorithm !== "static") {
      return;
    }
    if (this.totalWrites === 0 || this.totalWrites % this.staticMoveInterval !== 0) {
      return;
    }

    const activeBlocks = this.getActiveBlocks(false);
    const lowWearStatic = activeBlocks
      .filter((b) => b.hasStaticData)
      .sort((a, b) => a.wear - b.wear)[0];

    const highWearDynamic = activeBlocks
      .filter((b) => !b.hasStaticData)
      .sort((a, b) => b.wear - a.wear)[0];

    if (!lowWearStatic || !highWearDynamic) {
      return;
    }

    const tempAddress = lowWearStatic.logicalAddress;
    lowWearStatic.logicalAddress = highWearDynamic.logicalAddress;
    highWearDynamic.logicalAddress = tempAddress;

    lowWearStatic.hasStaticData = false;
    highWearDynamic.hasStaticData = true;

    this.markBlockWear(lowWearStatic, 1);
    this.markBlockWear(highWearDynamic, 1);
    this.relocations += 1;
  }

  simulateWrite() {
    this.time += 1;
    const logicalAddress = this.pickLogicalAddress();
    const target = this.chooseTargetBlock(logicalAddress);

    if (!target) {
      return;
    }

    const previousPhysicalId = this.logicalToPhysical[logicalAddress];
    this.maybeRunTrim(previousPhysicalId);

    if (this.features.ftl) {
      this.logicalToPhysical[logicalAddress] = target.id;
      this.ftlMoves.push({
        time: this.time,
        lba: logicalAddress,
        pba: target.id
      });
      if (this.ftlMoves.length > 25) {
        this.ftlMoves.shift();
      }
    }

    target.logicalAddress = logicalAddress;
    target.hasStaticData = false;

    this.markBlockWear(target, 1);

    this.totalWrites += 1;
    this.lastWrittenBlockId = target.id;
    this.writeHistory.push({ time: this.time, failedBlocks: this.failedBlocks, writes: this.totalWrites });

    if (this.writeHistory.length > 500) {
      this.writeHistory.shift();
    }

    this.maybeRunGarbageCollection();
    this.maybeRunStaticRelocation();
  }

  simulateBatch(writes = 1) {
    for (let i = 0; i < writes; i += 1) {
      this.simulateWrite();
    }
  }

  computeStats() {
    const wearValues = this.blocks.map((b) => b.wear);
    const totalWear = wearValues.reduce((sum, v) => sum + v, 0);
    const avgWearRaw = wearValues.length ? totalWear / wearValues.length : 0;
    const maxWearRaw = wearValues.length ? Math.max(...wearValues) : 0;

    const variance = wearValues.length
      ? wearValues.reduce((sum, v) => sum + (v - avgWearRaw) ** 2, 0) / wearValues.length
      : 0;

    const avgWearPercent = (avgWearRaw / this.endurance) * 100;
    const maxWearPercent = (maxWearRaw / this.endurance) * 100;

    const activeNonReserve = this.blocks.filter((b) => !b.isReserve).length || this.blocks.length;
    const failureRatio = this.failedBlocks / activeNonReserve;
    let lifespanText = "Healthy";

    if (failureRatio >= 0.5) {
      lifespanText = "Critical";
    } else if (failureRatio >= 0.2) {
      lifespanText = "Degrading";
    }

    return {
      totalWrites: this.totalWrites,
      avgWearPercent,
      maxWearPercent,
      variance,
      failedBlocks: this.failedBlocks,
      failureRatio,
      estimatedLifespan: `${lifespanText} (${(100 - failureRatio * 100).toFixed(1)}% blocks healthy)`,
      relocations: this.relocations
    };
  }

  getHistogram() {
    const bins = {
      healthy: 0,
      moderate: 0,
      high: 0,
      nearFailure: 0,
      failed: 0
    };

    this.blocks.forEach((block) => {
      const state = this.getBlockStateByWear(block);
      if (bins[state] !== undefined) {
        bins[state] += 1;
      }
    });

    return bins;
  }

  getWearPercentages() {
    return this.blocks.map((block) => Math.min(100, (block.wear / this.endurance) * 100));
  }

  exportSnapshot() {
    return {
      timestamp: new Date().toISOString(),
      config: {
        blockCount: this.blockCount,
        endurance: this.endurance,
        algorithm: this.algorithm,
        workload: this.workload,
        features: this.features
      },
      stats: this.computeStats(),
      blocks: this.blocks
    };
  }
}

class SSDLabController {
  constructor() {
    this.timer = null;
    this.compareTimer = null;
    this.charts = {};
    this.isRunning = false;
    this.chartsReady = false;
    this.initElements();
    this.bindEvents();
    this.createSimulationModels();
    this.setupCharts();
    this.renderAll();
    this.runBenchmark();
    this.updateButtonStates();
  }

  initElements() {
    this.els = {
      tabs: [...document.querySelectorAll(".tab-btn")],
      panels: [...document.querySelectorAll(".tab-panel")],
      blockGrid: document.getElementById("blockGrid"),
      startBtn: document.getElementById("startBtn"),
      pauseBtn: document.getElementById("pauseBtn"),
      resetBtn: document.getElementById("resetBtn"),
      randomizeBtn: document.getElementById("randomizeBtn"),
      exportBtn: document.getElementById("exportBtn"),
      algorithmSelect: document.getElementById("algorithmSelect"),
      workloadMode: document.getElementById("workloadMode"),
      speedSlider: document.getElementById("speedSlider"),
      enduranceSlider: document.getElementById("enduranceSlider"),
      blocksSlider: document.getElementById("blocksSlider"),
      staticMoveInterval: document.getElementById("staticMoveInterval"),
      speedValue: document.getElementById("speedValue"),
      enduranceValue: document.getElementById("enduranceValue"),
      blocksValue: document.getElementById("blocksValue"),
      staticMoveIntervalValue: document.getElementById("staticMoveIntervalValue"),
      totalWrites: document.getElementById("totalWrites"),
      avgWear: document.getElementById("avgWear"),
      maxWear: document.getElementById("maxWear"),
      wearVariance: document.getElementById("wearVariance"),
      failedBlocks: document.getElementById("failedBlocks"),
      lifespanEstimate: document.getElementById("lifespanEstimate"),
      comparisonToggle: document.getElementById("comparisonToggle"),
      comparisonAlgorithm: document.getElementById("comparisonAlgorithm"),
      comparisonWrap: document.getElementById("comparisonWrap"),
      compareGridNone: document.getElementById("compareGridNone"),
      compareGridSmart: document.getElementById("compareGridSmart"),
      compareStatsNone: document.getElementById("compareStatsNone"),
      compareStatsSmart: document.getElementById("compareStatsSmart"),
      compareLabelRight: document.getElementById("compareLabelRight"),
      toggleOverProvision: document.getElementById("toggleOverProvision"),
      toggleGC: document.getElementById("toggleGC"),
      toggleTRIM: document.getElementById("toggleTRIM"),
      toggleBadBlock: document.getElementById("toggleBadBlock"),
      toggleFTL: document.getElementById("toggleFTL"),
      toggleResearch: document.getElementById("toggleResearch"),
      researchPanel: document.getElementById("researchPanel"),
      reserveRatio: document.getElementById("reserveRatio"),
      hotsetRatio: document.getElementById("hotsetRatio"),
      gcThreshold: document.getElementById("gcThreshold"),
      reserveRatioValue: document.getElementById("reserveRatioValue"),
      hotsetRatioValue: document.getElementById("hotsetRatioValue"),
      gcThresholdValue: document.getElementById("gcThresholdValue"),
      heroBlockCount: document.getElementById("heroBlockCount"),
      heroEndurance: document.getElementById("heroEndurance"),
      heroMode: document.getElementById("heroMode")
    };
  }

  getConfigFromUI(algorithmOverride = null) {
    return {
      blockCount: Number(this.els.blocksSlider.value),
      endurance: Number(this.els.enduranceSlider.value),
      algorithm: algorithmOverride || this.els.algorithmSelect.value,
      workload: this.els.workloadMode.value,
      staticMoveInterval: Number(this.els.staticMoveInterval.value),
      hotsetRatio: Number(this.els.hotsetRatio.value),
      gcThreshold: Number(this.els.gcThreshold.value),
      reserveRatio: Number(this.els.reserveRatio.value),
      features: {
        overProvisioning: this.els.toggleOverProvision.checked,
        garbageCollection: this.els.toggleGC.checked,
        trim: this.els.toggleTRIM.checked,
        badBlockReplacement: this.els.toggleBadBlock.checked,
        ftl: this.els.toggleFTL.checked
      }
    };
  }

  createSimulationModels() {
    this.model = new SSDModel(this.getConfigFromUI());
    this.compareNoneModel = new SSDModel(this.getConfigFromUI("none"));
    this.compareSmartModel = new SSDModel(this.getConfigFromUI(this.els.comparisonAlgorithm.value));
  }

  bindEvents() {
    this.els.tabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        this.els.tabs.forEach((b) => b.classList.remove("active"));
        this.els.panels.forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.dataset.tab).classList.add("active");
      });
    });

    this.els.startBtn.addEventListener("click", () => this.start());
    this.els.pauseBtn.addEventListener("click", () => this.pause());
    this.els.resetBtn.addEventListener("click", () => this.reset());
    this.els.randomizeBtn.addEventListener("click", () => this.randomizeWorkload());
    this.els.exportBtn.addEventListener("click", () => this.exportResults());

    const valueBindings = [
      [this.els.speedSlider, this.els.speedValue],
      [this.els.enduranceSlider, this.els.enduranceValue],
      [this.els.blocksSlider, this.els.blocksValue],
      [this.els.staticMoveInterval, this.els.staticMoveIntervalValue],
      [this.els.reserveRatio, this.els.reserveRatioValue],
      [this.els.hotsetRatio, this.els.hotsetRatioValue],
      [this.els.gcThreshold, this.els.gcThresholdValue]
    ];

    valueBindings.forEach(([input, label]) => {
      input.addEventListener("input", () => {
        label.textContent = input.value;
        this.updateHero();
        if (input === this.els.speedSlider && this.isRunning) {
          this.start(true);
        }
      });
    });

    const resetTriggers = [
      this.els.algorithmSelect,
      this.els.workloadMode,
      this.els.enduranceSlider,
      this.els.blocksSlider,
      this.els.staticMoveInterval,
      this.els.toggleOverProvision,
      this.els.toggleGC,
      this.els.toggleTRIM,
      this.els.toggleBadBlock,
      this.els.toggleFTL,
      this.els.reserveRatio,
      this.els.hotsetRatio,
      this.els.gcThreshold,
      this.els.comparisonAlgorithm
    ];

    resetTriggers.forEach((el) => {
      el.addEventListener("change", () => {
        this.reset();
      });
    });

    this.els.comparisonToggle.addEventListener("change", () => {
      this.els.comparisonWrap.classList.toggle("hidden", !this.els.comparisonToggle.checked);
      if (this.els.comparisonToggle.checked) {
        this.resetComparisonModels();
        if (this.isRunning) {
          const { interval, writesPerTick } = this.getTimingSettings();
          this.startComparisonLoop(interval, writesPerTick);
        }
      } else if (this.compareTimer) {
        window.clearInterval(this.compareTimer);
        this.compareTimer = null;
      }
      this.renderComparison();
    });

    this.els.toggleResearch.addEventListener("change", () => {
      this.els.researchPanel.classList.toggle("hidden", !this.els.toggleResearch.checked);
    });
  }

  getTimingSettings() {
    const speed = Number(this.els.speedSlider.value);
    const interval = Math.max(30, Math.floor(1000 / speed));
    const writesPerTick = Math.max(1, Math.ceil(speed / 12));
    return { interval, writesPerTick };
  }

  startComparisonLoop(interval, writesPerTick) {
    if (this.compareTimer) {
      window.clearInterval(this.compareTimer);
      this.compareTimer = null;
    }

    this.compareTimer = window.setInterval(() => {
      this.compareNoneModel.simulateBatch(writesPerTick);
      this.compareSmartModel.simulateBatch(writesPerTick);
      this.renderComparison();
    }, interval);
  }

  updateButtonStates() {
    this.els.startBtn.disabled = this.isRunning;
    this.els.pauseBtn.disabled = !this.isRunning;
  }

  start(forceRestart = false) {
    if (this.isRunning && !forceRestart) {
      return;
    }

    this.pause();

    const { interval, writesPerTick } = this.getTimingSettings();

    this.isRunning = true;
    this.updateButtonStates();

    this.timer = window.setInterval(() => {
      this.model.simulateBatch(writesPerTick);
      this.renderAll();
    }, interval);

    if (this.els.comparisonToggle.checked) {
      this.startComparisonLoop(interval, writesPerTick);
    }
  }

  pause() {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.compareTimer) {
      window.clearInterval(this.compareTimer);
      this.compareTimer = null;
    }
    this.isRunning = false;
    this.updateButtonStates();
  }

  resetComparisonModels() {
    this.compareNoneModel.configure(this.getConfigFromUI("none"));
    this.compareSmartModel.configure(this.getConfigFromUI(this.els.comparisonAlgorithm.value));
    this.els.compareLabelRight.textContent =
      this.els.comparisonAlgorithm.value === "dynamic"
        ? "Dynamic Wear Leveling"
        : "Static Wear Leveling";
  }

  reset() {
    this.pause();
    this.createSimulationModels();
    this.renderAll();
    this.runBenchmark();
  }

  updateHero() {
    this.els.heroBlockCount.textContent = this.els.blocksSlider.value;
    this.els.heroEndurance.textContent = this.els.enduranceSlider.value;
    const modeText = {
      none: "No Wear Leveling",
      dynamic: "Dynamic Wear Leveling",
      static: "Static Wear Leveling"
    };
    this.els.heroMode.textContent = modeText[this.els.algorithmSelect.value] || "No Wear Leveling";
  }

  randomizeWorkload() {
    const workloads = ["random", "sequential", "hotspot"];
    const randomWorkload = workloads[Math.floor(Math.random() * workloads.length)];
    this.els.workloadMode.value = randomWorkload;
    this.els.hotsetRatio.value = String(Math.floor(Math.random() * 25) + 5);
    this.els.hotsetRatioValue.textContent = this.els.hotsetRatio.value;
    this.reset();
    this.start();
  }

  renderBlockGrid(container, model) {
    const blocksHtml = model.blocks
      .map((block) => {
        const state = model.getBlockStateByWear(block);
        const color = WEAR_COLORS[state];
        const activeClass = model.lastWrittenBlockId === block.id ? "active" : "";
        const tooltip = [
          `Block ${block.id}`,
          `Wear: ${block.wear}/${model.endurance}`,
          `Health: ${block.health.toFixed(1)}%`,
          `State: ${state}`,
          block.isReserve ? "Reserve block" : "Active block"
        ].join(" | ");

        return `<div class="block ${activeClass}" style="background:${color}" title="${tooltip}"></div>`;
      })
      .join("");

    container.innerHTML = blocksHtml;
  }

  updateMetrics() {
    const stats = this.model.computeStats();
    this.els.totalWrites.textContent = String(stats.totalWrites);
    this.els.avgWear.textContent = `${stats.avgWearPercent.toFixed(2)}%`;
    this.els.maxWear.textContent = `${stats.maxWearPercent.toFixed(2)}%`;
    this.els.wearVariance.textContent = stats.variance.toFixed(2);
    this.els.failedBlocks.textContent = String(stats.failedBlocks);
    this.els.lifespanEstimate.textContent = stats.estimatedLifespan;
  }

  renderComparison() {
    if (!this.els.comparisonToggle.checked) {
      return;
    }

    this.renderBlockGrid(this.els.compareGridNone, this.compareNoneModel);
    this.renderBlockGrid(this.els.compareGridSmart, this.compareSmartModel);

    const leftStats = this.compareNoneModel.computeStats();
    const rightStats = this.compareSmartModel.computeStats();

    this.els.compareStatsNone.textContent = `Writes: ${leftStats.totalWrites} | Failed: ${leftStats.failedBlocks} | Avg Wear: ${leftStats.avgWearPercent.toFixed(1)}%`;
    this.els.compareStatsSmart.textContent = `Writes: ${rightStats.totalWrites} | Failed: ${rightStats.failedBlocks} | Avg Wear: ${rightStats.avgWearPercent.toFixed(1)}%`;

    this.updateLifespanChart(leftStats, rightStats);
  }

  setupCharts() {
    if (typeof Chart === "undefined") {
      this.chartsReady = false;
      return;
    }

    const commonOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#d7f5ff" } }
      },
      scales: {
        x: { ticks: { color: "#9fc8d3" }, grid: { color: "rgba(120,220,255,0.1)" } },
        y: { ticks: { color: "#9fc8d3" }, grid: { color: "rgba(120,220,255,0.1)" } }
      }
    };

    this.charts.wearDistribution = new Chart(document.getElementById("wearDistributionChart"), {
      type: "line",
      data: {
        labels: [],
        datasets: [{
          label: "Wear % by Block",
          data: [],
          borderColor: "#4ee8ff",
          backgroundColor: "rgba(78, 232, 255, 0.2)",
          fill: true,
          tension: 0.2,
          pointRadius: 0
        }]
      },
      options: {
        ...commonOpts,
        scales: {
          ...commonOpts.scales,
          y: {
            ...commonOpts.scales.y,
            min: 0,
            max: 100
          }
        }
      }
    });

    this.charts.healthHistogram = new Chart(document.getElementById("healthHistogramChart"), {
      type: "bar",
      data: {
        labels: ["Healthy", "Moderate", "High", "Near Fail", "Failed"],
        datasets: [{
          label: "Block Count",
          data: [0, 0, 0, 0, 0],
          backgroundColor: ["#58d68d", "#f7dc6f", "#f39c4c", "#ff6d5f", "#4a4f59"]
        }]
      },
      options: {
        ...commonOpts,
        scales: {
          ...commonOpts.scales,
          y: {
            ...commonOpts.scales.y,
            min: 0,
            max: Number(this.els.blocksSlider.value)
          }
        }
      }
    });

    this.charts.lifespanComparison = new Chart(document.getElementById("lifespanComparisonChart"), {
      type: "bar",
      data: {
        labels: ["No WL", "Smart WL"],
        datasets: [{
          label: "Healthy Blocks (%)",
          data: [100, 100],
          backgroundColor: ["#ff6d5f", "#58d68d"]
        }]
      },
      options: {
        ...commonOpts,
        scales: {
          ...commonOpts.scales,
          y: {
            ...commonOpts.scales.y,
            min: 0,
            max: 100
          }
        }
      }
    });

    this.charts.performance = new Chart(document.getElementById("performanceChart"), {
      type: "radar",
      data: {
        labels: ["Endurance", "Balance", "Failure Delay", "Reliability"],
        datasets: []
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: "#d7f5ff" } }
        },
        scales: {
          r: {
            min: 0,
            max: 100,
            grid: { color: "rgba(120,220,255,0.14)" },
            pointLabels: { color: "#9fc8d3" },
            ticks: { color: "#9fc8d3", backdropColor: "transparent" }
          }
        }
      }
    });

    this.chartsReady = true;
  }

  updateCharts() {
    if (!this.chartsReady) {
      return;
    }

    const wear = this.model.getWearPercentages();
    this.charts.wearDistribution.data.labels = wear.map((_, i) => String(i));
    this.charts.wearDistribution.data.datasets[0].data = wear;
    this.charts.wearDistribution.update("none");

    const histogram = this.model.getHistogram();
    this.charts.healthHistogram.data.datasets[0].data = [
      histogram.healthy,
      histogram.moderate,
      histogram.high,
      histogram.nearFailure,
      histogram.failed
    ];
    this.charts.healthHistogram.options.scales.y.max = Number(this.els.blocksSlider.value);
    this.charts.healthHistogram.update("none");

    if (!this.els.comparisonToggle.checked) {
      const stats = this.model.computeStats();
      this.updateLifespanChart({ failureRatio: stats.failureRatio }, { failureRatio: 0 });
    }
  }

  updateLifespanChart(leftStats, rightStats) {
    if (!this.chartsReady) {
      return;
    }

    this.charts.lifespanComparison.data.datasets[0].data = [
      Math.max(0, 100 - leftStats.failureRatio * 100),
      Math.max(0, 100 - rightStats.failureRatio * 100)
    ];
    this.charts.lifespanComparison.update("none");
  }

  runBenchmark() {
    if (!this.chartsReady) {
      return;
    }

    const baseConfig = this.getConfigFromUI();
    const algorithms = ["none", "dynamic", "static"];
    const benchmarkResults = {};

    algorithms.forEach((algo) => {
      const bench = new SSDModel({ ...baseConfig, algorithm: algo });
      const maxWrites = 6000;
      let writes = 0;
      while (writes < maxWrites) {
        bench.simulateBatch(8);
        writes += 8;
        const failureThreshold = Math.floor(bench.blockCount * 0.1);
        if (bench.failedBlocks >= failureThreshold) {
          break;
        }
      }
      const stats = bench.computeStats();
      benchmarkResults[algo] = {
        enduranceScore: Math.max(5, 100 - stats.avgWearPercent),
        balanceScore: Math.max(5, 100 - Math.min(100, stats.variance / 2)),
        failureDelay: Math.min(100, (bench.totalWrites / maxWrites) * 100),
        reliability: Math.max(5, 100 - stats.failureRatio * 100)
      };
    });

    this.charts.performance.data.datasets = [
      {
        label: "No WL",
        data: [
          benchmarkResults.none.enduranceScore,
          benchmarkResults.none.balanceScore,
          benchmarkResults.none.failureDelay,
          benchmarkResults.none.reliability
        ],
        borderColor: "#ff6d5f",
        backgroundColor: "rgba(255,109,95,0.2)"
      },
      {
        label: "Dynamic",
        data: [
          benchmarkResults.dynamic.enduranceScore,
          benchmarkResults.dynamic.balanceScore,
          benchmarkResults.dynamic.failureDelay,
          benchmarkResults.dynamic.reliability
        ],
        borderColor: "#4ee8ff",
        backgroundColor: "rgba(78,232,255,0.2)"
      },
      {
        label: "Static",
        data: [
          benchmarkResults.static.enduranceScore,
          benchmarkResults.static.balanceScore,
          benchmarkResults.static.failureDelay,
          benchmarkResults.static.reliability
        ],
        borderColor: "#ffb454",
        backgroundColor: "rgba(255,180,84,0.2)"
      }
    ];

    this.charts.performance.update();
  }

  exportResults() {
    const payload = {
      simulator: this.model.exportSnapshot(),
      comparison: this.els.comparisonToggle.checked
        ? {
            none: this.compareNoneModel.exportSnapshot(),
            smart: this.compareSmartModel.exportSnapshot()
          }
        : null
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ssd-sim-results-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  renderAll() {
    this.updateHero();
    this.renderBlockGrid(this.els.blockGrid, this.model);
    this.updateMetrics();
    this.updateCharts();
    this.renderComparison();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new SSDLabController();
});
