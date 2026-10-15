(function (root, factory) {
  const api = factory(root);
  root.HM = Object.assign(root.HM || {}, api);
  if (typeof module === "object" && module != null && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const HM = root.HM;
  let pointer = null;
  let drag = null;
  let floatFrame = 0;
  let floatPoint = null;
  let snapTarget = null;
  const dragStart = 5;
  const dragCommit = 12;
  const SNAP_STACK = 48;
  const SNAP_SLOT = 40;
  const MAGNET = 0.42;

  function catClass(id) {
    return "cat-" + id;
  }

  function shapeOf(opcode) {
    return HM.CATALOG[opcode].shape;
  }

  function dragKind(blocks) {
    const shape = shapeOf(blocks[0].opcode);
    if (blocks.length === 1 && (shape === "reporter" || shape === "boolean")) return shape;
    return "stack";
  }

  function childPath(seq, index, branch) {
    return HM.encodePath(HM.decodePath(seq || "").concat(index, branch));
  }

  function renderPart(block, part, ctx) {
    if (part.type === "text") {
      const span = document.createElement("span");
      span.textContent = part.text;
      return span;
    }
    if (part.type === "menu") {
      if (ctx.preview) {
        const span = document.createElement("span");
        span.className = "shadow";
        const options = HM.menuOptions(part.options);
        const found = options.find((option) => option[0] === String(block.fields[part.field]));
        span.textContent = found ? found[1] : String(block.fields[part.field] ?? part.default ?? "");
        return span;
      }
      const select = document.createElement("select");
      select.className = "menu";
      const options = HM.menuOptions(part.options).slice();
      const current = String(block.fields[part.field] ?? part.default ?? "");
      if (current && !options.some((option) => option[0] === current)) options.unshift([current, current]);
      options.forEach((option) => {
        const node = document.createElement("option");
        node.value = option[0];
        node.textContent = option[1];
        select.appendChild(node);
      });
      select.value = current;
      let armed = true;
      select.addEventListener("focus", () => { armed = true; });
      select.addEventListener("change", () => {
        if (armed) {
          armed = false;
          HM.noteHistory();
        }
        block.fields[part.field] = select.value;
        HM.afterEdit();
      });
      return select;
    }
    const socket = document.createElement("div");
    socket.className = "socket";
    socket.dataset.accept = part.type === "bool" ? "boolean" : "reporter";
    socket.dataset.parentId = block.id;
    socket.dataset.input = part.input;
    const child = block.inputs[part.input];
    if (child) {
      socket.appendChild(renderBlock(child, { preview: ctx.preview, socket: true }));
      return socket;
    }
    if (part.type === "bool") {
      socket.classList.add("socket-empty");
      return socket;
    }
    if (ctx.preview) {
      const span = document.createElement("span");
      span.className = "shadow";
      span.textContent = String(block.fields[part.input] ?? part.fallback ?? "");
      socket.appendChild(span);
      return socket;
    }
    const input = document.createElement("input");
    input.className = part.kind === "text" ? "word" : "num";
    input.type = part.kind === "text" ? "text" : "number";
    if (part.kind === "number") input.step = "any";
    input.value = block.fields[part.input] ?? part.fallback ?? "";
    let armed = true;
    input.addEventListener("focus", () => { armed = true; });
    input.addEventListener("input", () => {
      if (armed) {
        armed = false;
        HM.noteHistory();
      }
      block.fields[part.input] = input.type === "number" ? Number(input.value) : input.value;
      HM.afterEdit();
    });
    socket.appendChild(input);
    return socket;
  }

  function renderBar(block, parts, ctx, mid) {
    const bar = document.createElement("div");
    bar.className = mid ? "block-bar mid" : "block-bar";
    if (!parts.length && mid) bar.textContent = mid;
    parts.forEach((part) => bar.appendChild(renderPart(block, part, ctx)));
    return bar;
  }

  function renderBlock(block, ctx) {
    const def = HM.CATALOG[block.opcode];
    const el = document.createElement("div");
    el.className = "block shape-" + def.shape + " " + catClass(def.category);
    el.dataset.blockId = block.id;
    el.dataset.opcode = block.opcode;
    el.dataset.shape = def.shape;
    if (!ctx.socket && ctx.stackId) {
      el.dataset.stackId = ctx.stackId;
      el.dataset.seq = ctx.seq || "";
      el.dataset.index = String(ctx.index);
    }
    if (block.id === HM.selectedId) el.classList.add("is-selected");
    if (block.id === HM.activeId) el.classList.add("is-active");
    el.appendChild(renderBar(block, def.parts, ctx));
    (def.branches || []).forEach((branch, index) => {
      if (index > 0) el.appendChild(renderBar(block, [], ctx, branch.label || "else"));
      const mouth = document.createElement("div");
      mouth.className = "mouth";
      const seq = childPath(ctx.seq || "", ctx.index || 0, branch.key);
      mouth.appendChild(renderSequence(block.branches[branch.key] || [], ctx.stackId, seq, ctx.preview));
      el.appendChild(mouth);
    });
    if (def.branches) {
      const cap = document.createElement("div");
      cap.className = "cap";
      el.appendChild(cap);
    }
    return el;
  }

  function renderHot(stackId, seq, index) {
    const hot = document.createElement("div");
    hot.className = "hot";
    hot.dataset.stackId = stackId;
    hot.dataset.seq = seq || "";
    hot.dataset.index = String(index);
    if (HM.cursor && HM.cursor.stackId === stackId && (HM.cursor.seq || "") === (seq || "") && HM.cursor.index === index) {
      hot.classList.add("is-cursor");
    }
    return hot;
  }

  function renderSequence(list, stackId, seq, preview) {
    const el = document.createElement("div");
    el.className = "seq";
    for (let i = 0; i <= list.length; i++) {
      if (!preview) el.appendChild(renderHot(stackId, seq, i));
      if (i < list.length) {
        el.appendChild(renderBlock(list[i], { stackId, seq, index: i, preview: !!preview }));
      }
    }
    return el;
  }

  function renderStacks() {
    const world = document.getElementById("canvas-world");
    world.innerHTML = "";
    if (!HM.project.stacks.length) {
      const empty = document.createElement("div");
      empty.className = "empty-canvas";
      empty.innerHTML = "<strong>Start with Events.</strong><span>Click “when program starts”, or open a lesson.</span>";
      world.appendChild(empty);
    }
    HM.project.stacks.forEach((stack) => {
      const wrap = document.createElement("div");
      wrap.className = "stack";
      wrap.style.left = stack.x + "px";
      wrap.style.top = stack.y + "px";
      wrap.dataset.stackId = stack.id;
      wrap.appendChild(renderSequence(stack.blocks, stack.id, "", false));
      world.appendChild(wrap);
    });
  }

  function renderFlyout() {
    const fly = document.getElementById("flyout");
    const meta = HM.CATEGORIES.find((item) => item.id === HM.category) || HM.CATEGORIES[0];
    fly.innerHTML = "";
    const head = document.createElement("div");
    head.className = "fly-head cat-" + meta.id;
    head.innerHTML = "<strong></strong><p></p>";
    head.querySelector("strong").textContent = meta.label;
    head.querySelector("p").textContent = meta.hint;
    fly.appendChild(head);
    if (meta.id === "learn") {
      const open = document.createElement("button");
      open.className = "text-btn";
      open.type = "button";
      open.textContent = "Open training lab";
      open.addEventListener("click", () => HM.openLab());
      fly.appendChild(open);
    }
    if (meta.id === "vars") {
      const add = document.createElement("button");
      add.className = "text-btn";
      add.type = "button";
      add.textContent = "New variable";
      add.addEventListener("click", () => HM.createVariable());
      fly.appendChild(add);
    }
    Object.keys(HM.CATALOG).forEach((opcode) => {
      if (HM.CATALOG[opcode].hidden || HM.CATALOG[opcode].category !== meta.id) return;
      const preview = renderBlock(HM.makeBlock(opcode), { preview: true, stackId: "", seq: "", index: 0 });
      preview.classList.add("in-palette");
      preview.dataset.opcode = opcode;
      fly.appendChild(preview);
    });
  }

  function render() {
    if (HM.cursor) {
      const alive = HM.project.stacks.some((stack) => stack.id === HM.cursor.stackId);
      if (!alive) HM.cursor = null;
    }
    if (!HM.cursor && HM.project.stacks[0]) {
      const stack = HM.project.stacks[0];
      HM.cursor = { stackId: stack.id, seq: "", index: stack.blocks.length };
    }
    renderStacks();
    renderFlyout();
  }

  function visit(id) {
    HM.activeId = id || null;
    document.querySelectorAll("#canvas-world .block.is-active").forEach((el) => el.classList.remove("is-active"));
    if (!id) return;
    document.querySelectorAll("#canvas-world .block").forEach((el) => {
      if (el.dataset.blockId === id) el.classList.add("is-active");
    });
  }

  function paintSelection() {
    document.querySelectorAll("#canvas-world .block.is-selected").forEach((el) => el.classList.remove("is-selected"));
    if (!HM.selectedId) return;
    document.querySelectorAll("#canvas-world .block").forEach((el) => {
      if (el.dataset.blockId === HM.selectedId) el.classList.add("is-selected");
    });
  }

  function paintCursor() {
    document.querySelectorAll("#canvas-world .hot.is-cursor").forEach((el) => el.classList.remove("is-cursor"));
    if (!HM.cursor) return;
    document.querySelectorAll("#canvas-world .hot").forEach((el) => {
      if (el.dataset.stackId === HM.cursor.stackId && (el.dataset.seq || "") === (HM.cursor.seq || "") && Number(el.dataset.index) === HM.cursor.index) {
        el.classList.add("is-cursor");
      }
    });
  }

  function cursorStack() {
    if (!HM.cursor) return null;
    return HM.project.stacks.find((stack) => stack.id === HM.cursor.stackId) || null;
  }

  function blockBeforeCursor() {
    const stack = cursorStack();
    if (!stack || !HM.cursor || HM.cursor.index <= 0) return null;
    try {
      const list = HM.sequence(stack, HM.decodePath(HM.cursor.seq));
      return list[HM.cursor.index - 1] || null;
    } catch (err) {
      return null;
    }
  }

  function matchingSockets(block, shape) {
    return (HM.CATALOG[block.opcode].parts || []).filter((part) => {
      if (block.inputs[part.input]) return false;
      if (shape === "boolean") return part.type === "bool";
      return part.type === "slot";
    });
  }

  function placeHolding(block) {
    const item = {
      id: HM.uid("s"),
      x: 48 + (HM.project.stacks.length % 5) * 18,
      y: 48 + (HM.project.stacks.length % 4) * 18,
      blocks: [block],
    };
    HM.project.stacks.push(item);
    HM.selectedId = block.id;
  }

  function clickAdd(opcode) {
    if (HM.running) {
      HM.toast("Stop the program before changing blocks.");
      return;
    }
    const backup = HM.serialize();
    const block = HM.makeBlock(opcode);
    const shape = shapeOf(opcode);
    if (shape === "reporter" || shape === "boolean") {
      const host = blockBeforeCursor();
      const sockets = host ? matchingSockets(host, shape) : [];
      if (sockets.length === 1) {
        host.inputs[sockets[0].input] = block;
        HM.selectedId = block.id;
        HM.pushHistory(backup);
        HM.refresh();
        return;
      }
      placeHolding(block);
      HM.pushHistory(backup);
      HM.refresh();
      return;
    }
    if (shape === "hat" || !cursorStack()) {
      const item = {
        id: HM.uid("s"),
        x: 32 + (HM.project.stacks.length % 4) * 26,
        y: 28 + (HM.project.stacks.length % 6) * 22,
        blocks: [block],
      };
      HM.project.stacks.push(item);
      HM.cursor = { stackId: item.id, seq: "", index: 1 };
    } else {
      const stack = cursorStack();
      try {
        const at = HM.insertAt(stack, HM.decodePath(HM.cursor.seq), HM.cursor.index, [block]);
        HM.cursor = { stackId: stack.id, seq: HM.cursor.seq, index: at + 1 };
      } catch (err) {
        const item = { id: HM.uid("s"), x: 36, y: 36, blocks: [block] };
        HM.project.stacks.push(item);
        HM.cursor = { stackId: item.id, seq: "", index: 1 };
      }
    }
    HM.selectedId = block.id;
    HM.pushHistory(backup);
    HM.refresh();
  }

  function deleteSelected() {
    if (HM.running || !HM.selectedId) return;
    const found = HM.locate(HM.project, HM.selectedId);
    if (!found) return;
    const backup = HM.serialize();
    if (found.kind === "socket") found.parent.inputs[found.input] = null;
    else {
      HM.takeTail(found.list, found.index);
      HM.pruneStack(HM.project, found.stack);
    }
    HM.selectedId = null;
    HM.pushHistory(backup);
    HM.refresh();
  }

  function nearest(selector, x, y, limit, accept) {
    let best = null;
    let bestD = limit;
    document.querySelectorAll(selector).forEach((el) => {
      if (accept && el.dataset.accept !== accept) return;
      if (el.closest("#drag-float")) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      const cx = Math.max(rect.left, Math.min(x, rect.right));
      const cy = Math.max(rect.top, Math.min(y, rect.bottom));
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < bestD) {
        bestD = dist;
        best = el;
      }
    });
    return best;
  }

  function hoverTarget(x, y) {
    if (!drag) return null;
    if (drag.kind === "stack") return nearest("#canvas-world .hot", x, y, SNAP_STACK);
    if (drag.kind === "reporter") return nearest("#canvas-world .socket", x, y, SNAP_SLOT, "reporter");
    if (drag.kind === "boolean") return nearest("#canvas-world .socket", x, y, SNAP_SLOT, "boolean");
    return null;
  }

  function clearTargets() {
    document.querySelectorAll(".is-target").forEach((el) => el.classList.remove("is-target"));
    snapTarget = null;
  }

  function paintTarget(target) {
    document.querySelectorAll(".is-target").forEach((el) => {
      if (el !== target) el.classList.remove("is-target");
    });
    snapTarget = target || null;
    if (target) target.classList.add("is-target");
  }

  function magnetize(x, y, target) {
    let px = x - drag.dx;
    let py = y - drag.dy;
    if (!target) return { x: px, y: py, scale: 1.03 };
    const rect = target.getBoundingClientRect();
    if (target.classList.contains("hot")) {
      const wantX = rect.left - 6;
      const wantY = rect.top + rect.height / 2 - 18;
      px += (wantX - px) * MAGNET;
      py += (wantY - py) * MAGNET;
      return { x: px, y: py, scale: 1.02 };
    }
    const wantX = rect.left - 4;
    const wantY = rect.top + rect.height / 2 - 14;
    px += (wantX - px) * MAGNET;
    py += (wantY - py) * MAGNET;
    return { x: px, y: py, scale: 1.02 };
  }

  function placeFloat(x, y, target) {
    const float = document.getElementById("drag-float");
    if (!float || !drag) return;
    const pos = magnetize(x, y, target);
    float.style.transform = "translate3d(" + pos.x + "px," + pos.y + "px,0) scale(" + pos.scale + ")";
  }

  function moveFloat(event) {
    if (!drag || drag.dropping) return;
    floatPoint = { x: event.clientX, y: event.clientY };
    if (floatFrame) return;
    floatFrame = requestAnimationFrame(() => {
      floatFrame = 0;
      if (!drag || !floatPoint) return;
      const target = hoverTarget(floatPoint.x, floatPoint.y);
      paintTarget(target);
      placeFloat(floatPoint.x, floatPoint.y, target);
    });
  }

  function showFloat(x, y) {
    const float = document.createElement("div");
    float.id = "drag-float";
    float.appendChild(renderSequence(drag.blocks, "float", "", true));
    document.body.appendChild(float);
    document.body.classList.add("is-dragging");
    document.getElementById("trash").hidden = false;
    placeFloat(x, y, null);
  }

  function markOrigin(on) {
    if (!drag || !drag.blocks) return;
    drag.blocks.forEach((block) => {
      const el = document.querySelector('#canvas-world .block[data-block-id="' + block.id + '"]');
      if (el) el.classList.toggle("is-drag-origin", on);
    });
  }

  function endDrag() {
    if (floatFrame) cancelAnimationFrame(floatFrame);
    floatFrame = 0;
    floatPoint = null;
    markOrigin(false);
    const float = document.getElementById("drag-float");
    if (float) float.remove();
    clearTargets();
    document.getElementById("trash").hidden = true;
    document.body.classList.remove("is-dragging");
    drag = null;
  }

  function softDrop(then) {
    const float = document.getElementById("drag-float");
    if (!float) {
      endDrag();
      then();
      return;
    }
    if (drag) drag.dropping = true;
    pointer = null;
    float.classList.add("is-dropping");
    if (snapTarget) {
      const rect = snapTarget.getBoundingClientRect();
      const px = rect.left - (drag ? drag.dx * 0.2 : 0);
      const py = rect.top - 8;
      float.style.transform = "translate3d(" + px + "px," + py + "px,0) scale(0.98)";
    }
    window.setTimeout(() => {
      endDrag();
      then();
    }, 90);
  }

  function idsIn(block, into) {
    into.add(block.id);
    Object.keys(block.inputs || {}).forEach((key) => {
      if (block.inputs[key]) idsIn(block.inputs[key], into);
    });
    Object.keys(block.branches || {}).forEach((key) => {
      (block.branches[key] || []).forEach((child) => idsIn(child, into));
    });
  }

  function dropHitsDragged(target) {
    if (!drag.source || !target) return false;
    const ids = new Set();
    drag.blocks.forEach((block) => idsIn(block, ids));
    if (target.classList.contains("socket")) {
      if (drag.source.kind === "socket" && target.dataset.parentId === drag.source.parent.id && target.dataset.input === drag.source.input) return true;
      return ids.has(target.dataset.parentId);
    }
    if (target.dataset.stackId !== drag.source.stack.id) return false;
    const src = drag.source.seq ? drag.source.seq.split("/") : [];
    const dst = target.dataset.seq ? target.dataset.seq.split("/") : [];
    if (dst.join("/") === src.join("/")) {
      const index = Number(target.dataset.index);
      return index >= drag.source.index && index <= drag.source.index + drag.blocks.length;
    }
    if (dst.length < src.length + 1) return false;
    for (let i = 0; i < src.length; i++) if (dst[i] !== src[i]) return false;
    return Number(dst[src.length]) >= drag.source.index;
  }

  function detachSource() {
    if (drag.source.kind === "socket") {
      drag.source.parent.inputs[drag.source.input] = null;
      return;
    }
    drag.blocks = HM.takeTail(drag.source.list, drag.source.index);
    HM.pruneStack(HM.project, drag.source.stack);
  }

  function startDrag(info) {
    if (info.kind === "new") {
      const block = HM.makeBlock(info.opcode);
      drag = { blocks: [block], kind: dragKind([block]), dx: info.dx, dy: info.dy, fromExisting: false };
      showFloat(info.x, info.y);
      return;
    }
    const found = HM.locate(HM.project, info.id);
    if (!found) return;
    const blocks = found.kind === "socket" ? [found.block] : found.list.slice(found.index);
    if (!blocks.length) return;
    drag = {
      blocks: blocks,
      dx: info.dx,
      dy: info.dy,
      fromExisting: true,
      backup: HM.serialize(),
      source: found,
    };
    drag.kind = dragKind(drag.blocks);
    markOrigin(true);
    showFloat(info.x, info.y);
  }

  function underPointer(event) {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    return el && el.closest ? el : null;
  }

  function dropOn(event) {
    if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < dragCommit) {
      endDrag();
      return;
    }
    const under = underPointer(event);
    const trash = under && under.closest("#trash, #flyout, #rail");
    if (trash) {
      if (drag.fromExisting) {
        HM.pushHistory(drag.backup);
        detachSource();
      }
      softDrop(() => HM.refresh());
      return;
    }
    const target = snapTarget || hoverTarget(event.clientX, event.clientY);
    if (drag.fromExisting && dropHitsDragged(target)) {
      endDrag();
      return;
    }
    let placed = false;
    if (drag.fromExisting) detachSource();
    if (target && target.classList.contains("hot") && drag.kind === "stack") {
      const stack = HM.project.stacks.find((item) => item.id === target.dataset.stackId);
      if (stack) {
        const at = HM.insertAt(stack, HM.decodePath(target.dataset.seq || ""), Number(target.dataset.index), drag.blocks);
        HM.cursor = { stackId: stack.id, seq: target.dataset.seq || "", index: at + drag.blocks.length };
        HM.selectedId = drag.blocks[0].id;
        placed = true;
      }
    } else if (target && target.classList.contains("socket") && drag.blocks.length === 1) {
      const found = HM.locate(HM.project, target.dataset.parentId);
      if (found) {
        const previous = found.block.inputs[target.dataset.input];
        found.block.inputs[target.dataset.input] = drag.blocks[0];
        if (previous) placeHolding(previous);
        HM.selectedId = drag.blocks[0].id;
        placed = true;
      }
    }
    if (!placed) {
      const canvas = document.getElementById("canvas-scroll");
      const world = document.getElementById("canvas-world");
      const view = canvas.getBoundingClientRect();
      const origin = world.getBoundingClientRect();
      const inside = event.clientX >= view.left && event.clientX <= view.right && event.clientY >= view.top && event.clientY <= view.bottom;
      if (!inside) {
        if (drag.fromExisting) HM.restore(drag.backup, { history: false });
        endDrag();
        return;
      }
      const item = {
        id: HM.uid("s"),
        x: Math.max(12, event.clientX - drag.dx - origin.left),
        y: Math.max(12, event.clientY - drag.dy - origin.top),
        blocks: drag.blocks,
      };
      HM.project.stacks.push(item);
      HM.cursor = { stackId: item.id, seq: "", index: item.blocks.length };
      HM.selectedId = item.blocks[0].id;
      placed = true;
    }
    if (placed) {
      if (drag.fromExisting) HM.pushHistory(drag.backup);
      else HM.pushHistory(HM._beforeNew || HM.serialize());
    }
    softDrop(() => HM.refresh());
  }

  function onDown(event) {
    if (event.button !== 0) return;
    if (drag && drag.dropping) return;
    if (event.target.closest("input, select, textarea, button, a, label")) return;
    const palette = event.target.closest("#flyout .block");
    const blockEl = event.target.closest("#canvas-world .block");
    const hot = event.target.closest("#canvas-world .hot");
    if (HM.running && (palette || blockEl || hot)) {
      HM.toast("Stop the program before moving blocks.");
      return;
    }
    if (palette || blockEl) {
      event.preventDefault();
      try { document.body.setPointerCapture(event.pointerId); } catch (err) { /* pointer already released */ }
    }
    if (palette) {
      const rect = palette.getBoundingClientRect();
      HM._beforeNew = HM.serialize();
      pointer = {
        kind: "new",
        opcode: palette.dataset.opcode,
        x: event.clientX,
        y: event.clientY,
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top,
        moved: false,
      };
      return;
    }
    if (blockEl && blockEl.dataset.blockId) {
      const rect = blockEl.getBoundingClientRect();
      pointer = {
        kind: "move",
        id: blockEl.dataset.blockId,
        x: event.clientX,
        y: event.clientY,
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top,
        moved: false,
      };
      return;
    }
    if (hot) {
      HM.cursor = { stackId: hot.dataset.stackId, seq: hot.dataset.seq || "", index: Number(hot.dataset.index) };
      HM.selectedId = null;
      paintSelection();
      paintCursor();
      return;
    }
    const scroll = document.getElementById("canvas-scroll");
    if (event.target.closest("#canvas-scroll")) {
      pointer = { kind: "pan", x: event.clientX, y: event.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop };
    }
  }

  function onMove(event) {
    if (drag) {
      if (drag.dropping) return;
      moveFloat(event);
      return;
    }
    if (!pointer) return;
    if (pointer.kind === "pan") {
      const scroll = document.getElementById("canvas-scroll");
      scroll.scrollLeft = pointer.sl - (event.clientX - pointer.x);
      scroll.scrollTop = pointer.st - (event.clientY - pointer.y);
      return;
    }
    if (!pointer.moved && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < dragStart) return;
    pointer.moved = true;
    startDrag(pointer);
    moveFloat(event);
  }

  function onUp(event) {
    const far = pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= dragCommit;
    if (drag && far) {
      dropOn(event);
      pointer = null;
      return;
    }
    if (drag) endDrag();
    if (!pointer) return;
    if (pointer.kind === "new" && !far) clickAdd(pointer.opcode);
    else if (pointer.kind === "move" && !far) {
      HM.selectedId = pointer.id;
      const el = document.querySelector("#canvas-world .block[data-block-id='" + pointer.id + "']");
      if (el && el.dataset.stackId) {
        HM.cursor = { stackId: el.dataset.stackId, seq: el.dataset.seq || "", index: Number(el.dataset.index) + 1 };
      }
      paintSelection();
      paintCursor();
    }
    pointer = null;
  }

  function mount() {
    HM.category = HM.category || "move";
    document.getElementById("rail").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-cat]");
      if (!button) return;
      HM.category = button.dataset.cat;
      document.querySelectorAll("#rail button").forEach((node) => node.classList.toggle("is-on", node === button));
      renderFlyout();
    });
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    render();
  }

  return {
    editor: { mount, render, renderFlyout, visit, deleteSelected, clickAdd },
  };
});
