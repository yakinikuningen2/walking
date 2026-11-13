// Presentation only. Search, storage, location and routing remain in app.js.
(() => {
  const mobile = window.matchMedia("(max-width: 840px), (max-width: 1080px) and (max-height: 480px)");
  const navigation = [...document.querySelectorAll("[data-view]")];
  const screens = { search: ui["discovery-screen"], saved: searchPanel, settings: ui["setup-screen"] };
  let currentView = ui["setup-screen"].hidden ? "map" : "settings";
  let layoutFrame = null;

  // Explicit pointer feedback also covers touch browsers that defer :active.
  let pressedControl = null;
  function clearPressedControl() {
    pressedControl?.classList.remove("is-pressed");
    pressedControl = null;
  }
  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    clearPressedControl();
    const control = event.target.closest("button, summary");
    if (!control || control.matches(":disabled")) return;
    pressedControl = control;
    control.classList.add("is-pressed");
  }, true);
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    document.addEventListener(type, clearPressedControl, true);
  }
  document.addEventListener("pointerout", (event) => {
    if (pressedControl && !pressedControl.contains(event.relatedTarget)) clearPressedControl();
  }, true);
  window.addEventListener("blur", clearPressedControl);
  document.addEventListener("visibilitychange", clearPressedControl);

  function svgIcon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({ class: "icon", viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
      svg.setAttribute(key, value);
    }
    const use = document.createElementNS(svg.namespaceURI, "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function refreshMapSize() {
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      map.invalidateSize({ animate: false, debounceMoveend: true });
    });
  }

  function syncNavigation() {
    const visible = { search: !screens.search.hidden, saved: panelIsOpen(), settings: !screens.settings.hidden };
    if (!visible[currentView]) currentView = Object.keys(visible).find((key) => visible[key]) || "map";
    document.body.dataset.view = currentView;
    document.body.classList.toggle("workspace-open", currentView !== "map");
    for (const button of navigation) {
      if (button.dataset.view === currentView) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    refreshMapSize();
    syncPresets();
  }

  function closePeers(view) {
    if (view !== "saved" && panelIsOpen()) setPanelOpen(false, false);
    if (view !== "search" && !screens.search.hidden) setDiscoveryOpen(false, false);
    if (view !== "settings" && !screens.settings.hidden) closeWalkingSettings(false);
  }

  function openView(view) {
    closePeers(view);
    currentView = view;
    if (view === "search" && screens.search.hidden) setDiscoveryOpen(true, false);
    if (view === "saved" && !panelIsOpen()) setPanelOpen(true, false);
    if (view === "settings" && screens.settings.hidden) openWalkingSettings();
    syncNavigation();
  }

  for (const button of navigation) button.addEventListener("click", () => openView(button.dataset.view));
  document.querySelector(".app-brand").addEventListener("click", (event) => {
    event.preventDefault();
    openView("map");
  });
  document.getElementById("close-registration").addEventListener("click", () => {
    setPanelOpen(false, false);
    navigation.find((button) => button.dataset.view === "saved").focus({ preventScroll: true });
  });

  // Existing entry points (markers, start selection, settings and Escape) also
  // update the navigation. Observe state rather than replacing their handlers.
  const panels = new MutationObserver((records) => {
    let opened;
    for (const record of records) {
      if (record.target === screens.search && !screens.search.hidden) opened = "search";
      if (record.target === screens.settings && !screens.settings.hidden) opened = "settings";
      if (record.target === appShell && panelIsOpen() && !String(record.oldValue).includes("panel-open")) opened = "saved";
    }
    if (opened) { closePeers(opened); currentView = opened; }
    syncNavigation();
  });
  panels.observe(appShell, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
  for (const screen of [screens.search, screens.settings]) panels.observe(screen, { attributes: true, attributeFilter: ["hidden"] });

  function setExpanded(screen, expanded) {
    screen.classList.toggle("is-expanded", expanded);
    const button = screen.querySelector(".sheet-expand");
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", expanded ? "シートを小さくする" : "シートを展開");
    if (screen === screens.search) scheduleDiscoveryViewport();
  }

  for (const screen of Object.values(screens)) {
    screen.querySelector(".sheet-expand").addEventListener("click", () => {
      setExpanded(screen, !screen.classList.contains("is-expanded"));
    });
    const grip = screen.querySelector(".sheet-grip");
    let drag = null;
    // On phones the same grip expands the bottom sheet; desktop search dragging
    // continues to use the existing app.js implementation.
    grip.addEventListener("pointerdown", (event) => {
      if (!mobile.matches || event.button !== 0 || event.isPrimary === false) return;
      event.stopImmediatePropagation();
      drag = { id: event.pointerId, y: event.clientY };
      grip.setPointerCapture(event.pointerId);
    }, true);
    grip.addEventListener("pointermove", (event) => {
      if (drag && event.pointerId === drag.id) event.stopImmediatePropagation();
    }, true);
    grip.addEventListener("pointerup", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      event.stopImmediatePropagation();
      const distance = event.clientY - drag.y;
      drag = null;
      if (distance < -30) setExpanded(screen, true);
      else if (distance > 50) {
        if (screen.classList.contains("is-expanded")) setExpanded(screen, false);
        else openView("map");
      }
    }, true);
    for (const name of ["pointercancel", "lostpointercapture"]) grip.addEventListener(name, () => { drag = null; });
  }

  function syncPresets() {
    const minutes = Number(ui["discovery-hours"].value) * 60 + Number(ui["discovery-minutes"].value);
    for (const button of document.querySelectorAll("[data-minutes]")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.minutes) === minutes));
    }
    for (const button of document.querySelectorAll("[data-kind]")) {
      button.setAttribute("aria-pressed", String(button.dataset.kind === ui["discovery-kind"].value));
    }
    const active = ui["discovery-ambience"].value !== "any" || ui["discovery-direction"].value !== "any"
      || ui["discovery-high-elevation"].checked || !!ui["discovery-keyword"].value.trim();
    document.getElementById("advanced-count").textContent = active ? "指定あり" : "";
  }
  for (const button of document.querySelectorAll("[data-minutes]")) button.addEventListener("click", () => {
    const minutes = Number(button.dataset.minutes);
    ui["discovery-hours"].value = Math.floor(minutes / 60);
    ui["discovery-minutes"].value = minutes % 60;
    ui["discovery-hours"].dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (const button of document.querySelectorAll("[data-kind]")) button.addEventListener("click", () => {
    ui["discovery-kind"].value = button.dataset.kind;
    ui["discovery-kind"].dispatchEvent(new Event("change", { bubbles: true }));
  });
  ui["discovery-form"].addEventListener("input", syncPresets);
  ui["discovery-form"].addEventListener("change", syncPresets);
  ui["discovery-history-list"].addEventListener("click", () => {
    syncPresets();
    document.getElementById("advanced-conditions").open = !!document.getElementById("advanced-count").textContent;
  });

  function decorateUtilities() {
    const icons = { "location-button": "location", "follow-location": "arrow", "edit-walking-settings": "walk" };
    for (const [id, name] of Object.entries(icons)) {
      const button = ui[id];
      if (!button.querySelector("svg")) button.prepend(svgIcon(name));
      const label = button.textContent.trim();
      button.setAttribute("aria-label", label);
      button.title = label;
    }
  }
  new MutationObserver(decorateUtilities).observe(document.querySelector(".map-utility-actions"), { childList: true, subtree: true });
  decorateUtilities();

  function decorateCandidates() {
    const places = discoveryResultsRequest?.places || [];
    document.getElementById("discovery-count").textContent = `${places.length}件`;
    for (const button of ui["discovery-results"].querySelectorAll("[data-place-key]")) {
      if (button.querySelector(".place-kind-icon")) continue;
      const place = places.find((candidate) => candidate.key === button.dataset.placeKey);
      const name = { park: "tree", mountain: "mountain", forest: "tree", autumn_leaves: "leaf", cherry_blossom: "leaf" }[place?.kindId] || "pin";
      const badge = document.createElement("span");
      badge.className = "place-kind-icon";
      badge.setAttribute("aria-hidden", "true");
      badge.append(svgIcon(name));
      button.prepend(badge);
    }
    syncPresets();
  }
  new MutationObserver(decorateCandidates).observe(ui["discovery-results"], { childList: true, subtree: true });
  decorateCandidates();

  // Keep distance and time visible when the route's larger card is closed.
  function syncRouteSummary() {
    const button = ui["toggle-route-details"];
    const summary = ui["route-summary"].textContent.split("（")[0].trim();
    const collapsed = ui["route-details-content"].hidden;
    const label = collapsed ? (summary ? `${summary} · 詳細` : "ルート詳細") : "詳細を閉じる";
    if (button.textContent !== label) button.textContent = label;
  }
  const routePresentation = new MutationObserver(syncRouteSummary);
  routePresentation.observe(ui["route-summary"], { childList: true, characterData: true, subtree: true });
  routePresentation.observe(ui["route-details-content"], { attributes: true, attributeFilter: ["hidden"] });
  routePresentation.observe(ui["toggle-route-details"], { childList: true });
  syncRouteSummary();

  mobile.addEventListener("change", () => {
    discoveryPanelOffset = { x: 0, y: 0 };
    screens.search.style.removeProperty("--discovery-drag-x");
    screens.search.style.removeProperty("--discovery-drag-y");
    syncNavigation();
  });
  window.addEventListener("resize", refreshMapSize);
  map.zoomControl?.setPosition("topright");
  openView("map");
})();
