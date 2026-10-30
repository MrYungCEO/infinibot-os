(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __decorateClass = (decorators, target, key, kind) => {
    var result = kind > 1 ? void 0 : kind ? __getOwnPropDesc(target, key) : target;
    for (var i6 = decorators.length - 1, decorator; i6 >= 0; i6--)
      if (decorator = decorators[i6])
        result = (kind ? decorator(target, key, result) : decorator(result)) || result;
    if (kind && result) __defProp(target, key, result);
    return result;
  };

  // ../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/css-tag.js
  var t = globalThis;
  var e = t.ShadowRoot && (void 0 === t.ShadyCSS || t.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype;
  var s = /* @__PURE__ */ Symbol();
  var o = /* @__PURE__ */ new WeakMap();
  var n = class {
    constructor(t5, e6, o7) {
      if (this._$cssResult$ = true, o7 !== s) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
      this.cssText = t5, this.t = e6;
    }
    get styleSheet() {
      let t5 = this.o;
      const s5 = this.t;
      if (e && void 0 === t5) {
        const e6 = void 0 !== s5 && 1 === s5.length;
        e6 && (t5 = o.get(s5)), void 0 === t5 && ((this.o = t5 = new CSSStyleSheet()).replaceSync(this.cssText), e6 && o.set(s5, t5));
      }
      return t5;
    }
    toString() {
      return this.cssText;
    }
  };
  var r = (t5) => new n("string" == typeof t5 ? t5 : t5 + "", void 0, s);
  var i = (t5, ...e6) => {
    const o7 = 1 === t5.length ? t5[0] : e6.reduce((e7, s5, o8) => e7 + ((t6) => {
      if (true === t6._$cssResult$) return t6.cssText;
      if ("number" == typeof t6) return t6;
      throw Error("Value passed to 'css' function must be a 'css' function result: " + t6 + ". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.");
    })(s5) + t5[o8 + 1], t5[0]);
    return new n(o7, t5, s);
  };
  var S = (s5, o7) => {
    if (e) s5.adoptedStyleSheets = o7.map((t5) => t5 instanceof CSSStyleSheet ? t5 : t5.styleSheet);
    else for (const e6 of o7) {
      const o8 = document.createElement("style"), n6 = t.litNonce;
      void 0 !== n6 && o8.setAttribute("nonce", n6), o8.textContent = e6.cssText, s5.appendChild(o8);
    }
  };
  var c = e ? (t5) => t5 : (t5) => t5 instanceof CSSStyleSheet ? ((t6) => {
    let e6 = "";
    for (const s5 of t6.cssRules) e6 += s5.cssText;
    return r(e6);
  })(t5) : t5;

  // ../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/reactive-element.js
  var { is: i2, defineProperty: e2, getOwnPropertyDescriptor: h, getOwnPropertyNames: r2, getOwnPropertySymbols: o2, getPrototypeOf: n2 } = Object;
  var a = globalThis;
  var c2 = a.trustedTypes;
  var l = c2 ? c2.emptyScript : "";
  var p = a.reactiveElementPolyfillSupport;
  var d = (t5, s5) => t5;
  var u = { toAttribute(t5, s5) {
    switch (s5) {
      case Boolean:
        t5 = t5 ? l : null;
        break;
      case Object:
      case Array:
        t5 = null == t5 ? t5 : JSON.stringify(t5);
    }
    return t5;
  }, fromAttribute(t5, s5) {
    let i6 = t5;
    switch (s5) {
      case Boolean:
        i6 = null !== t5;
        break;
      case Number:
        i6 = null === t5 ? null : Number(t5);
        break;
      case Object:
      case Array:
        try {
          i6 = JSON.parse(t5);
        } catch (t6) {
          i6 = null;
        }
    }
    return i6;
  } };
  var f = (t5, s5) => !i2(t5, s5);
  var b = { attribute: true, type: String, converter: u, reflect: false, useDefault: false, hasChanged: f };
  Symbol.metadata ?? (Symbol.metadata = /* @__PURE__ */ Symbol("metadata")), a.litPropertyMetadata ?? (a.litPropertyMetadata = /* @__PURE__ */ new WeakMap());
  var y = class extends HTMLElement {
    static addInitializer(t5) {
      this._$Ei(), (this.l ?? (this.l = [])).push(t5);
    }
    static get observedAttributes() {
      return this.finalize(), this._$Eh && [...this._$Eh.keys()];
    }
    static createProperty(t5, s5 = b) {
      if (s5.state && (s5.attribute = false), this._$Ei(), this.prototype.hasOwnProperty(t5) && ((s5 = Object.create(s5)).wrapped = true), this.elementProperties.set(t5, s5), !s5.noAccessor) {
        const i6 = /* @__PURE__ */ Symbol(), h4 = this.getPropertyDescriptor(t5, i6, s5);
        void 0 !== h4 && e2(this.prototype, t5, h4);
      }
    }
    static getPropertyDescriptor(t5, s5, i6) {
      const { get: e6, set: r6 } = h(this.prototype, t5) ?? { get() {
        return this[s5];
      }, set(t6) {
        this[s5] = t6;
      } };
      return { get: e6, set(s6) {
        const h4 = e6?.call(this);
        r6?.call(this, s6), this.requestUpdate(t5, h4, i6);
      }, configurable: true, enumerable: true };
    }
    static getPropertyOptions(t5) {
      return this.elementProperties.get(t5) ?? b;
    }
    static _$Ei() {
      if (this.hasOwnProperty(d("elementProperties"))) return;
      const t5 = n2(this);
      t5.finalize(), void 0 !== t5.l && (this.l = [...t5.l]), this.elementProperties = new Map(t5.elementProperties);
    }
    static finalize() {
      if (this.hasOwnProperty(d("finalized"))) return;
      if (this.finalized = true, this._$Ei(), this.hasOwnProperty(d("properties"))) {
        const t6 = this.properties, s5 = [...r2(t6), ...o2(t6)];
        for (const i6 of s5) this.createProperty(i6, t6[i6]);
      }
      const t5 = this[Symbol.metadata];
      if (null !== t5) {
        const s5 = litPropertyMetadata.get(t5);
        if (void 0 !== s5) for (const [t6, i6] of s5) this.elementProperties.set(t6, i6);
      }
      this._$Eh = /* @__PURE__ */ new Map();
      for (const [t6, s5] of this.elementProperties) {
        const i6 = this._$Eu(t6, s5);
        void 0 !== i6 && this._$Eh.set(i6, t6);
      }
      this.elementStyles = this.finalizeStyles(this.styles);
    }
    static finalizeStyles(s5) {
      const i6 = [];
      if (Array.isArray(s5)) {
        const e6 = new Set(s5.flat(1 / 0).reverse());
        for (const s6 of e6) i6.unshift(c(s6));
      } else void 0 !== s5 && i6.push(c(s5));
      return i6;
    }
    static _$Eu(t5, s5) {
      const i6 = s5.attribute;
      return false === i6 ? void 0 : "string" == typeof i6 ? i6 : "string" == typeof t5 ? t5.toLowerCase() : void 0;
    }
    constructor() {
      super(), this._$Ep = void 0, this.isUpdatePending = false, this.hasUpdated = false, this._$Em = null, this._$Ev();
    }
    _$Ev() {
      this._$ES = new Promise((t5) => this.enableUpdating = t5), this._$AL = /* @__PURE__ */ new Map(), this._$E_(), this.requestUpdate(), this.constructor.l?.forEach((t5) => t5(this));
    }
    addController(t5) {
      (this._$EO ?? (this._$EO = /* @__PURE__ */ new Set())).add(t5), void 0 !== this.renderRoot && this.isConnected && t5.hostConnected?.();
    }
    removeController(t5) {
      this._$EO?.delete(t5);
    }
    _$E_() {
      const t5 = /* @__PURE__ */ new Map(), s5 = this.constructor.elementProperties;
      for (const i6 of s5.keys()) this.hasOwnProperty(i6) && (t5.set(i6, this[i6]), delete this[i6]);
      t5.size > 0 && (this._$Ep = t5);
    }
    createRenderRoot() {
      const t5 = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
      return S(t5, this.constructor.elementStyles), t5;
    }
    connectedCallback() {
      this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this.enableUpdating(true), this._$EO?.forEach((t5) => t5.hostConnected?.());
    }
    enableUpdating(t5) {
    }
    disconnectedCallback() {
      this._$EO?.forEach((t5) => t5.hostDisconnected?.());
    }
    attributeChangedCallback(t5, s5, i6) {
      this._$AK(t5, i6);
    }
    _$ET(t5, s5) {
      const i6 = this.constructor.elementProperties.get(t5), e6 = this.constructor._$Eu(t5, i6);
      if (void 0 !== e6 && true === i6.reflect) {
        const h4 = (void 0 !== i6.converter?.toAttribute ? i6.converter : u).toAttribute(s5, i6.type);
        this._$Em = t5, null == h4 ? this.removeAttribute(e6) : this.setAttribute(e6, h4), this._$Em = null;
      }
    }
    _$AK(t5, s5) {
      const i6 = this.constructor, e6 = i6._$Eh.get(t5);
      if (void 0 !== e6 && this._$Em !== e6) {
        const t6 = i6.getPropertyOptions(e6), h4 = "function" == typeof t6.converter ? { fromAttribute: t6.converter } : void 0 !== t6.converter?.fromAttribute ? t6.converter : u;
        this._$Em = e6;
        const r6 = h4.fromAttribute(s5, t6.type);
        this[e6] = r6 ?? this._$Ej?.get(e6) ?? r6, this._$Em = null;
      }
    }
    requestUpdate(t5, s5, i6, e6 = false, h4) {
      if (void 0 !== t5) {
        const r6 = this.constructor;
        if (false === e6 && (h4 = this[t5]), i6 ?? (i6 = r6.getPropertyOptions(t5)), !((i6.hasChanged ?? f)(h4, s5) || i6.useDefault && i6.reflect && h4 === this._$Ej?.get(t5) && !this.hasAttribute(r6._$Eu(t5, i6)))) return;
        this.C(t5, s5, i6);
      }
      false === this.isUpdatePending && (this._$ES = this._$EP());
    }
    C(t5, s5, { useDefault: i6, reflect: e6, wrapped: h4 }, r6) {
      i6 && !(this._$Ej ?? (this._$Ej = /* @__PURE__ */ new Map())).has(t5) && (this._$Ej.set(t5, r6 ?? s5 ?? this[t5]), true !== h4 || void 0 !== r6) || (this._$AL.has(t5) || (this.hasUpdated || i6 || (s5 = void 0), this._$AL.set(t5, s5)), true === e6 && this._$Em !== t5 && (this._$Eq ?? (this._$Eq = /* @__PURE__ */ new Set())).add(t5));
    }
    async _$EP() {
      this.isUpdatePending = true;
      try {
        await this._$ES;
      } catch (t6) {
        Promise.reject(t6);
      }
      const t5 = this.scheduleUpdate();
      return null != t5 && await t5, !this.isUpdatePending;
    }
    scheduleUpdate() {
      return this.performUpdate();
    }
    performUpdate() {
      if (!this.isUpdatePending) return;
      if (!this.hasUpdated) {
        if (this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this._$Ep) {
          for (const [t7, s6] of this._$Ep) this[t7] = s6;
          this._$Ep = void 0;
        }
        const t6 = this.constructor.elementProperties;
        if (t6.size > 0) for (const [s6, i6] of t6) {
          const { wrapped: t7 } = i6, e6 = this[s6];
          true !== t7 || this._$AL.has(s6) || void 0 === e6 || this.C(s6, void 0, i6, e6);
        }
      }
      let t5 = false;
      const s5 = this._$AL;
      try {
        t5 = this.shouldUpdate(s5), t5 ? (this.willUpdate(s5), this._$EO?.forEach((t6) => t6.hostUpdate?.()), this.update(s5)) : this._$EM();
      } catch (s6) {
        throw t5 = false, this._$EM(), s6;
      }
      t5 && this._$AE(s5);
    }
    willUpdate(t5) {
    }
    _$AE(t5) {
      this._$EO?.forEach((t6) => t6.hostUpdated?.()), this.hasUpdated || (this.hasUpdated = true, this.firstUpdated(t5)), this.updated(t5);
    }
    _$EM() {
      this._$AL = /* @__PURE__ */ new Map(), this.isUpdatePending = false;
    }
    get updateComplete() {
      return this.getUpdateComplete();
    }
    getUpdateComplete() {
      return this._$ES;
    }
    shouldUpdate(t5) {
      return true;
    }
    update(t5) {
      this._$Eq && (this._$Eq = this._$Eq.forEach((t6) => this._$ET(t6, this[t6]))), this._$EM();
    }
    updated(t5) {
    }
    firstUpdated(t5) {
    }
  };
  y.elementStyles = [], y.shadowRootOptions = { mode: "open" }, y[d("elementProperties")] = /* @__PURE__ */ new Map(), y[d("finalized")] = /* @__PURE__ */ new Map(), p?.({ ReactiveElement: y }), (a.reactiveElementVersions ?? (a.reactiveElementVersions = [])).push("2.1.2");

  // ../node_modules/.pnpm/lit-html@3.3.2/node_modules/lit-html/lit-html.js
  var t2 = globalThis;
  var i3 = (t5) => t5;
  var s2 = t2.trustedTypes;
  var e3 = s2 ? s2.createPolicy("lit-html", { createHTML: (t5) => t5 }) : void 0;
  var h2 = "$lit$";
  var o3 = `lit$${Math.random().toFixed(9).slice(2)}$`;
  var n3 = "?" + o3;
  var r3 = `<${n3}>`;
  var l2 = document;
  var c3 = () => l2.createComment("");
  var a2 = (t5) => null === t5 || "object" != typeof t5 && "function" != typeof t5;
  var u2 = Array.isArray;
  var d2 = (t5) => u2(t5) || "function" == typeof t5?.[Symbol.iterator];
  var f2 = "[ 	\n\f\r]";
  var v = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g;
  var _ = /-->/g;
  var m = />/g;
  var p2 = RegExp(`>|${f2}(?:([^\\s"'>=/]+)(${f2}*=${f2}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`, "g");
  var g = /'/g;
  var $ = /"/g;
  var y2 = /^(?:script|style|textarea|title)$/i;
  var x = (t5) => (i6, ...s5) => ({ _$litType$: t5, strings: i6, values: s5 });
  var b2 = x(1);
  var w = x(2);
  var T = x(3);
  var E = /* @__PURE__ */ Symbol.for("lit-noChange");
  var A = /* @__PURE__ */ Symbol.for("lit-nothing");
  var C = /* @__PURE__ */ new WeakMap();
  var P = l2.createTreeWalker(l2, 129);
  function V(t5, i6) {
    if (!u2(t5) || !t5.hasOwnProperty("raw")) throw Error("invalid template strings array");
    return void 0 !== e3 ? e3.createHTML(i6) : i6;
  }
  var N = (t5, i6) => {
    const s5 = t5.length - 1, e6 = [];
    let n6, l4 = 2 === i6 ? "<svg>" : 3 === i6 ? "<math>" : "", c5 = v;
    for (let i7 = 0; i7 < s5; i7++) {
      const s6 = t5[i7];
      let a4, u4, d4 = -1, f4 = 0;
      for (; f4 < s6.length && (c5.lastIndex = f4, u4 = c5.exec(s6), null !== u4); ) f4 = c5.lastIndex, c5 === v ? "!--" === u4[1] ? c5 = _ : void 0 !== u4[1] ? c5 = m : void 0 !== u4[2] ? (y2.test(u4[2]) && (n6 = RegExp("</" + u4[2], "g")), c5 = p2) : void 0 !== u4[3] && (c5 = p2) : c5 === p2 ? ">" === u4[0] ? (c5 = n6 ?? v, d4 = -1) : void 0 === u4[1] ? d4 = -2 : (d4 = c5.lastIndex - u4[2].length, a4 = u4[1], c5 = void 0 === u4[3] ? p2 : '"' === u4[3] ? $ : g) : c5 === $ || c5 === g ? c5 = p2 : c5 === _ || c5 === m ? c5 = v : (c5 = p2, n6 = void 0);
      const x3 = c5 === p2 && t5[i7 + 1].startsWith("/>") ? " " : "";
      l4 += c5 === v ? s6 + r3 : d4 >= 0 ? (e6.push(a4), s6.slice(0, d4) + h2 + s6.slice(d4) + o3 + x3) : s6 + o3 + (-2 === d4 ? i7 : x3);
    }
    return [V(t5, l4 + (t5[s5] || "<?>") + (2 === i6 ? "</svg>" : 3 === i6 ? "</math>" : "")), e6];
  };
  var S2 = class _S {
    constructor({ strings: t5, _$litType$: i6 }, e6) {
      let r6;
      this.parts = [];
      let l4 = 0, a4 = 0;
      const u4 = t5.length - 1, d4 = this.parts, [f4, v3] = N(t5, i6);
      if (this.el = _S.createElement(f4, e6), P.currentNode = this.el.content, 2 === i6 || 3 === i6) {
        const t6 = this.el.content.firstChild;
        t6.replaceWith(...t6.childNodes);
      }
      for (; null !== (r6 = P.nextNode()) && d4.length < u4; ) {
        if (1 === r6.nodeType) {
          if (r6.hasAttributes()) for (const t6 of r6.getAttributeNames()) if (t6.endsWith(h2)) {
            const i7 = v3[a4++], s5 = r6.getAttribute(t6).split(o3), e7 = /([.?@])?(.*)/.exec(i7);
            d4.push({ type: 1, index: l4, name: e7[2], strings: s5, ctor: "." === e7[1] ? I : "?" === e7[1] ? L : "@" === e7[1] ? z : H }), r6.removeAttribute(t6);
          } else t6.startsWith(o3) && (d4.push({ type: 6, index: l4 }), r6.removeAttribute(t6));
          if (y2.test(r6.tagName)) {
            const t6 = r6.textContent.split(o3), i7 = t6.length - 1;
            if (i7 > 0) {
              r6.textContent = s2 ? s2.emptyScript : "";
              for (let s5 = 0; s5 < i7; s5++) r6.append(t6[s5], c3()), P.nextNode(), d4.push({ type: 2, index: ++l4 });
              r6.append(t6[i7], c3());
            }
          }
        } else if (8 === r6.nodeType) if (r6.data === n3) d4.push({ type: 2, index: l4 });
        else {
          let t6 = -1;
          for (; -1 !== (t6 = r6.data.indexOf(o3, t6 + 1)); ) d4.push({ type: 7, index: l4 }), t6 += o3.length - 1;
        }
        l4++;
      }
    }
    static createElement(t5, i6) {
      const s5 = l2.createElement("template");
      return s5.innerHTML = t5, s5;
    }
  };
  function M(t5, i6, s5 = t5, e6) {
    if (i6 === E) return i6;
    let h4 = void 0 !== e6 ? s5._$Co?.[e6] : s5._$Cl;
    const o7 = a2(i6) ? void 0 : i6._$litDirective$;
    return h4?.constructor !== o7 && (h4?._$AO?.(false), void 0 === o7 ? h4 = void 0 : (h4 = new o7(t5), h4._$AT(t5, s5, e6)), void 0 !== e6 ? (s5._$Co ?? (s5._$Co = []))[e6] = h4 : s5._$Cl = h4), void 0 !== h4 && (i6 = M(t5, h4._$AS(t5, i6.values), h4, e6)), i6;
  }
  var R = class {
    constructor(t5, i6) {
      this._$AV = [], this._$AN = void 0, this._$AD = t5, this._$AM = i6;
    }
    get parentNode() {
      return this._$AM.parentNode;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    u(t5) {
      const { el: { content: i6 }, parts: s5 } = this._$AD, e6 = (t5?.creationScope ?? l2).importNode(i6, true);
      P.currentNode = e6;
      let h4 = P.nextNode(), o7 = 0, n6 = 0, r6 = s5[0];
      for (; void 0 !== r6; ) {
        if (o7 === r6.index) {
          let i7;
          2 === r6.type ? i7 = new k(h4, h4.nextSibling, this, t5) : 1 === r6.type ? i7 = new r6.ctor(h4, r6.name, r6.strings, this, t5) : 6 === r6.type && (i7 = new Z(h4, this, t5)), this._$AV.push(i7), r6 = s5[++n6];
        }
        o7 !== r6?.index && (h4 = P.nextNode(), o7++);
      }
      return P.currentNode = l2, e6;
    }
    p(t5) {
      let i6 = 0;
      for (const s5 of this._$AV) void 0 !== s5 && (void 0 !== s5.strings ? (s5._$AI(t5, s5, i6), i6 += s5.strings.length - 2) : s5._$AI(t5[i6])), i6++;
    }
  };
  var k = class _k {
    get _$AU() {
      return this._$AM?._$AU ?? this._$Cv;
    }
    constructor(t5, i6, s5, e6) {
      this.type = 2, this._$AH = A, this._$AN = void 0, this._$AA = t5, this._$AB = i6, this._$AM = s5, this.options = e6, this._$Cv = e6?.isConnected ?? true;
    }
    get parentNode() {
      let t5 = this._$AA.parentNode;
      const i6 = this._$AM;
      return void 0 !== i6 && 11 === t5?.nodeType && (t5 = i6.parentNode), t5;
    }
    get startNode() {
      return this._$AA;
    }
    get endNode() {
      return this._$AB;
    }
    _$AI(t5, i6 = this) {
      t5 = M(this, t5, i6), a2(t5) ? t5 === A || null == t5 || "" === t5 ? (this._$AH !== A && this._$AR(), this._$AH = A) : t5 !== this._$AH && t5 !== E && this._(t5) : void 0 !== t5._$litType$ ? this.$(t5) : void 0 !== t5.nodeType ? this.T(t5) : d2(t5) ? this.k(t5) : this._(t5);
    }
    O(t5) {
      return this._$AA.parentNode.insertBefore(t5, this._$AB);
    }
    T(t5) {
      this._$AH !== t5 && (this._$AR(), this._$AH = this.O(t5));
    }
    _(t5) {
      this._$AH !== A && a2(this._$AH) ? this._$AA.nextSibling.data = t5 : this.T(l2.createTextNode(t5)), this._$AH = t5;
    }
    $(t5) {
      const { values: i6, _$litType$: s5 } = t5, e6 = "number" == typeof s5 ? this._$AC(t5) : (void 0 === s5.el && (s5.el = S2.createElement(V(s5.h, s5.h[0]), this.options)), s5);
      if (this._$AH?._$AD === e6) this._$AH.p(i6);
      else {
        const t6 = new R(e6, this), s6 = t6.u(this.options);
        t6.p(i6), this.T(s6), this._$AH = t6;
      }
    }
    _$AC(t5) {
      let i6 = C.get(t5.strings);
      return void 0 === i6 && C.set(t5.strings, i6 = new S2(t5)), i6;
    }
    k(t5) {
      u2(this._$AH) || (this._$AH = [], this._$AR());
      const i6 = this._$AH;
      let s5, e6 = 0;
      for (const h4 of t5) e6 === i6.length ? i6.push(s5 = new _k(this.O(c3()), this.O(c3()), this, this.options)) : s5 = i6[e6], s5._$AI(h4), e6++;
      e6 < i6.length && (this._$AR(s5 && s5._$AB.nextSibling, e6), i6.length = e6);
    }
    _$AR(t5 = this._$AA.nextSibling, s5) {
      for (this._$AP?.(false, true, s5); t5 !== this._$AB; ) {
        const s6 = i3(t5).nextSibling;
        i3(t5).remove(), t5 = s6;
      }
    }
    setConnected(t5) {
      void 0 === this._$AM && (this._$Cv = t5, this._$AP?.(t5));
    }
  };
  var H = class {
    get tagName() {
      return this.element.tagName;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    constructor(t5, i6, s5, e6, h4) {
      this.type = 1, this._$AH = A, this._$AN = void 0, this.element = t5, this.name = i6, this._$AM = e6, this.options = h4, s5.length > 2 || "" !== s5[0] || "" !== s5[1] ? (this._$AH = Array(s5.length - 1).fill(new String()), this.strings = s5) : this._$AH = A;
    }
    _$AI(t5, i6 = this, s5, e6) {
      const h4 = this.strings;
      let o7 = false;
      if (void 0 === h4) t5 = M(this, t5, i6, 0), o7 = !a2(t5) || t5 !== this._$AH && t5 !== E, o7 && (this._$AH = t5);
      else {
        const e7 = t5;
        let n6, r6;
        for (t5 = h4[0], n6 = 0; n6 < h4.length - 1; n6++) r6 = M(this, e7[s5 + n6], i6, n6), r6 === E && (r6 = this._$AH[n6]), o7 || (o7 = !a2(r6) || r6 !== this._$AH[n6]), r6 === A ? t5 = A : t5 !== A && (t5 += (r6 ?? "") + h4[n6 + 1]), this._$AH[n6] = r6;
      }
      o7 && !e6 && this.j(t5);
    }
    j(t5) {
      t5 === A ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, t5 ?? "");
    }
  };
  var I = class extends H {
    constructor() {
      super(...arguments), this.type = 3;
    }
    j(t5) {
      this.element[this.name] = t5 === A ? void 0 : t5;
    }
  };
  var L = class extends H {
    constructor() {
      super(...arguments), this.type = 4;
    }
    j(t5) {
      this.element.toggleAttribute(this.name, !!t5 && t5 !== A);
    }
  };
  var z = class extends H {
    constructor(t5, i6, s5, e6, h4) {
      super(t5, i6, s5, e6, h4), this.type = 5;
    }
    _$AI(t5, i6 = this) {
      if ((t5 = M(this, t5, i6, 0) ?? A) === E) return;
      const s5 = this._$AH, e6 = t5 === A && s5 !== A || t5.capture !== s5.capture || t5.once !== s5.once || t5.passive !== s5.passive, h4 = t5 !== A && (s5 === A || e6);
      e6 && this.element.removeEventListener(this.name, this, s5), h4 && this.element.addEventListener(this.name, this, t5), this._$AH = t5;
    }
    handleEvent(t5) {
      "function" == typeof this._$AH ? this._$AH.call(this.options?.host ?? this.element, t5) : this._$AH.handleEvent(t5);
    }
  };
  var Z = class {
    constructor(t5, i6, s5) {
      this.element = t5, this.type = 6, this._$AN = void 0, this._$AM = i6, this.options = s5;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    _$AI(t5) {
      M(this, t5);
    }
  };
  var B = t2.litHtmlPolyfillSupport;
  B?.(S2, k), (t2.litHtmlVersions ?? (t2.litHtmlVersions = [])).push("3.3.2");

  // ../node_modules/.pnpm/lit-html@3.3.3/node_modules/lit-html/lit-html.js
  var t3 = globalThis;
  var i4 = (t5) => t5;
  var s3 = t3.trustedTypes;
  var e4 = s3 ? s3.createPolicy("lit-html", { createHTML: (t5) => t5 }) : void 0;
  var h3 = "$lit$";
  var o4 = `lit$${Math.random().toFixed(9).slice(2)}$`;
  var n4 = "?" + o4;
  var r4 = `<${n4}>`;
  var l3 = document;
  var c4 = () => l3.createComment("");
  var a3 = (t5) => null === t5 || "object" != typeof t5 && "function" != typeof t5;
  var u3 = Array.isArray;
  var d3 = (t5) => u3(t5) || "function" == typeof t5?.[Symbol.iterator];
  var f3 = "[ 	\n\f\r]";
  var v2 = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g;
  var _2 = /-->/g;
  var m2 = />/g;
  var p3 = RegExp(`>|${f3}(?:([^\\s"'>=/]+)(${f3}*=${f3}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`, "g");
  var g2 = /'/g;
  var $2 = /"/g;
  var y3 = /^(?:script|style|textarea|title)$/i;
  var x2 = (t5) => (i6, ...s5) => ({ _$litType$: t5, strings: i6, values: s5 });
  var b3 = x2(1);
  var w2 = x2(2);
  var T2 = x2(3);
  var E2 = /* @__PURE__ */ Symbol.for("lit-noChange");
  var A2 = /* @__PURE__ */ Symbol.for("lit-nothing");
  var C2 = /* @__PURE__ */ new WeakMap();
  var P2 = l3.createTreeWalker(l3, 129);
  function V2(t5, i6) {
    if (!u3(t5) || !t5.hasOwnProperty("raw")) throw Error("invalid template strings array");
    return void 0 !== e4 ? e4.createHTML(i6) : i6;
  }
  var N2 = (t5, i6) => {
    const s5 = t5.length - 1, e6 = [];
    let n6, l4 = 2 === i6 ? "<svg>" : 3 === i6 ? "<math>" : "", c5 = v2;
    for (let i7 = 0; i7 < s5; i7++) {
      const s6 = t5[i7];
      let a4, u4, d4 = -1, f4 = 0;
      for (; f4 < s6.length && (c5.lastIndex = f4, u4 = c5.exec(s6), null !== u4); ) f4 = c5.lastIndex, c5 === v2 ? "!--" === u4[1] ? c5 = _2 : void 0 !== u4[1] ? c5 = m2 : void 0 !== u4[2] ? (y3.test(u4[2]) && (n6 = RegExp("</" + u4[2], "g")), c5 = p3) : void 0 !== u4[3] && (c5 = p3) : c5 === p3 ? ">" === u4[0] ? (c5 = n6 ?? v2, d4 = -1) : void 0 === u4[1] ? d4 = -2 : (d4 = c5.lastIndex - u4[2].length, a4 = u4[1], c5 = void 0 === u4[3] ? p3 : '"' === u4[3] ? $2 : g2) : c5 === $2 || c5 === g2 ? c5 = p3 : c5 === _2 || c5 === m2 ? c5 = v2 : (c5 = p3, n6 = void 0);
      const x3 = c5 === p3 && t5[i7 + 1].startsWith("/>") ? " " : "";
      l4 += c5 === v2 ? s6 + r4 : d4 >= 0 ? (e6.push(a4), s6.slice(0, d4) + h3 + s6.slice(d4) + o4 + x3) : s6 + o4 + (-2 === d4 ? i7 : x3);
    }
    return [V2(t5, l4 + (t5[s5] || "<?>") + (2 === i6 ? "</svg>" : 3 === i6 ? "</math>" : "")), e6];
  };
  var S3 = class _S {
    constructor({ strings: t5, _$litType$: i6 }, e6) {
      let r6;
      this.parts = [];
      let l4 = 0, a4 = 0;
      const u4 = t5.length - 1, d4 = this.parts, [f4, v3] = N2(t5, i6);
      if (this.el = _S.createElement(f4, e6), P2.currentNode = this.el.content, 2 === i6 || 3 === i6) {
        const t6 = this.el.content.firstChild;
        t6.replaceWith(...t6.childNodes);
      }
      for (; null !== (r6 = P2.nextNode()) && d4.length < u4; ) {
        if (1 === r6.nodeType) {
          if (r6.hasAttributes()) for (const t6 of r6.getAttributeNames()) if (t6.endsWith(h3)) {
            const i7 = v3[a4++], s5 = r6.getAttribute(t6).split(o4), e7 = /([.?@])?(.*)/.exec(i7);
            d4.push({ type: 1, index: l4, name: e7[2], strings: s5, ctor: "." === e7[1] ? I2 : "?" === e7[1] ? L2 : "@" === e7[1] ? z2 : H2 }), r6.removeAttribute(t6);
          } else t6.startsWith(o4) && (d4.push({ type: 6, index: l4 }), r6.removeAttribute(t6));
          if (y3.test(r6.tagName)) {
            const t6 = r6.textContent.split(o4), i7 = t6.length - 1;
            if (i7 > 0) {
              r6.textContent = s3 ? s3.emptyScript : "";
              for (let s5 = 0; s5 < i7; s5++) r6.append(t6[s5], c4()), P2.nextNode(), d4.push({ type: 2, index: ++l4 });
              r6.append(t6[i7], c4());
            }
          }
        } else if (8 === r6.nodeType) if (r6.data === n4) d4.push({ type: 2, index: l4 });
        else {
          let t6 = -1;
          for (; -1 !== (t6 = r6.data.indexOf(o4, t6 + 1)); ) d4.push({ type: 7, index: l4 }), t6 += o4.length - 1;
        }
        l4++;
      }
    }
    static createElement(t5, i6) {
      const s5 = l3.createElement("template");
      return s5.innerHTML = t5, s5;
    }
  };
  function M2(t5, i6, s5 = t5, e6) {
    if (i6 === E2) return i6;
    let h4 = void 0 !== e6 ? s5._$Co?.[e6] : s5._$Cl;
    const o7 = a3(i6) ? void 0 : i6._$litDirective$;
    return h4?.constructor !== o7 && (h4?._$AO?.(false), void 0 === o7 ? h4 = void 0 : (h4 = new o7(t5), h4._$AT(t5, s5, e6)), void 0 !== e6 ? (s5._$Co ?? (s5._$Co = []))[e6] = h4 : s5._$Cl = h4), void 0 !== h4 && (i6 = M2(t5, h4._$AS(t5, i6.values), h4, e6)), i6;
  }
  var R2 = class {
    constructor(t5, i6) {
      this._$AV = [], this._$AN = void 0, this._$AD = t5, this._$AM = i6;
    }
    get parentNode() {
      return this._$AM.parentNode;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    u(t5) {
      const { el: { content: i6 }, parts: s5 } = this._$AD, e6 = (t5?.creationScope ?? l3).importNode(i6, true);
      P2.currentNode = e6;
      let h4 = P2.nextNode(), o7 = 0, n6 = 0, r6 = s5[0];
      for (; void 0 !== r6; ) {
        if (o7 === r6.index) {
          let i7;
          2 === r6.type ? i7 = new k2(h4, h4.nextSibling, this, t5) : 1 === r6.type ? i7 = new r6.ctor(h4, r6.name, r6.strings, this, t5) : 6 === r6.type && (i7 = new Z2(h4, this, t5)), this._$AV.push(i7), r6 = s5[++n6];
        }
        o7 !== r6?.index && (h4 = P2.nextNode(), o7++);
      }
      return P2.currentNode = l3, e6;
    }
    p(t5) {
      let i6 = 0;
      for (const s5 of this._$AV) void 0 !== s5 && (void 0 !== s5.strings ? (s5._$AI(t5, s5, i6), i6 += s5.strings.length - 2) : s5._$AI(t5[i6])), i6++;
    }
  };
  var k2 = class _k {
    get _$AU() {
      return this._$AM?._$AU ?? this._$Cv;
    }
    constructor(t5, i6, s5, e6) {
      this.type = 2, this._$AH = A2, this._$AN = void 0, this._$AA = t5, this._$AB = i6, this._$AM = s5, this.options = e6, this._$Cv = e6?.isConnected ?? true;
    }
    get parentNode() {
      let t5 = this._$AA.parentNode;
      const i6 = this._$AM;
      return void 0 !== i6 && 11 === t5?.nodeType && (t5 = i6.parentNode), t5;
    }
    get startNode() {
      return this._$AA;
    }
    get endNode() {
      return this._$AB;
    }
    _$AI(t5, i6 = this) {
      t5 = M2(this, t5, i6), a3(t5) ? t5 === A2 || null == t5 || "" === t5 ? (this._$AH !== A2 && this._$AR(), this._$AH = A2) : t5 !== this._$AH && t5 !== E2 && this._(t5) : void 0 !== t5._$litType$ ? this.$(t5) : void 0 !== t5.nodeType ? this.T(t5) : d3(t5) ? this.k(t5) : this._(t5);
    }
    O(t5) {
      return this._$AA.parentNode.insertBefore(t5, this._$AB);
    }
    T(t5) {
      this._$AH !== t5 && (this._$AR(), this._$AH = this.O(t5));
    }
    _(t5) {
      this._$AH !== A2 && a3(this._$AH) ? this._$AA.nextSibling.data = t5 : this.T(l3.createTextNode(t5)), this._$AH = t5;
    }
    $(t5) {
      const { values: i6, _$litType$: s5 } = t5, e6 = "number" == typeof s5 ? this._$AC(t5) : (void 0 === s5.el && (s5.el = S3.createElement(V2(s5.h, s5.h[0]), this.options)), s5);
      if (this._$AH?._$AD === e6) this._$AH.p(i6);
      else {
        const t6 = new R2(e6, this), s6 = t6.u(this.options);
        t6.p(i6), this.T(s6), this._$AH = t6;
      }
    }
    _$AC(t5) {
      let i6 = C2.get(t5.strings);
      return void 0 === i6 && C2.set(t5.strings, i6 = new S3(t5)), i6;
    }
    k(t5) {
      u3(this._$AH) || (this._$AH = [], this._$AR());
      const i6 = this._$AH;
      let s5, e6 = 0;
      for (const h4 of t5) e6 === i6.length ? i6.push(s5 = new _k(this.O(c4()), this.O(c4()), this, this.options)) : s5 = i6[e6], s5._$AI(h4), e6++;
      e6 < i6.length && (this._$AR(s5 && s5._$AB.nextSibling, e6), i6.length = e6);
    }
    _$AR(t5 = this._$AA.nextSibling, s5) {
      for (this._$AP?.(false, true, s5); t5 !== this._$AB; ) {
        const s6 = i4(t5).nextSibling;
        i4(t5).remove(), t5 = s6;
      }
    }
    setConnected(t5) {
      void 0 === this._$AM && (this._$Cv = t5, this._$AP?.(t5));
    }
  };
  var H2 = class {
    get tagName() {
      return this.element.tagName;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    constructor(t5, i6, s5, e6, h4) {
      this.type = 1, this._$AH = A2, this._$AN = void 0, this.element = t5, this.name = i6, this._$AM = e6, this.options = h4, s5.length > 2 || "" !== s5[0] || "" !== s5[1] ? (this._$AH = Array(s5.length - 1).fill(new String()), this.strings = s5) : this._$AH = A2;
    }
    _$AI(t5, i6 = this, s5, e6) {
      const h4 = this.strings;
      let o7 = false;
      if (void 0 === h4) t5 = M2(this, t5, i6, 0), o7 = !a3(t5) || t5 !== this._$AH && t5 !== E2, o7 && (this._$AH = t5);
      else {
        const e7 = t5;
        let n6, r6;
        for (t5 = h4[0], n6 = 0; n6 < h4.length - 1; n6++) r6 = M2(this, e7[s5 + n6], i6, n6), r6 === E2 && (r6 = this._$AH[n6]), o7 || (o7 = !a3(r6) || r6 !== this._$AH[n6]), r6 === A2 ? t5 = A2 : t5 !== A2 && (t5 += (r6 ?? "") + h4[n6 + 1]), this._$AH[n6] = r6;
      }
      o7 && !e6 && this.j(t5);
    }
    j(t5) {
      t5 === A2 ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, t5 ?? "");
    }
  };
  var I2 = class extends H2 {
    constructor() {
      super(...arguments), this.type = 3;
    }
    j(t5) {
      this.element[this.name] = t5 === A2 ? void 0 : t5;
    }
  };
  var L2 = class extends H2 {
    constructor() {
      super(...arguments), this.type = 4;
    }
    j(t5) {
      this.element.toggleAttribute(this.name, !!t5 && t5 !== A2);
    }
  };
  var z2 = class extends H2 {
    constructor(t5, i6, s5, e6, h4) {
      super(t5, i6, s5, e6, h4), this.type = 5;
    }
    _$AI(t5, i6 = this) {
      if ((t5 = M2(this, t5, i6, 0) ?? A2) === E2) return;
      const s5 = this._$AH, e6 = t5 === A2 && s5 !== A2 || t5.capture !== s5.capture || t5.once !== s5.once || t5.passive !== s5.passive, h4 = t5 !== A2 && (s5 === A2 || e6);
      e6 && this.element.removeEventListener(this.name, this, s5), h4 && this.element.addEventListener(this.name, this, t5), this._$AH = t5;
    }
    handleEvent(t5) {
      "function" == typeof this._$AH ? this._$AH.call(this.options?.host ?? this.element, t5) : this._$AH.handleEvent(t5);
    }
  };
  var Z2 = class {
    constructor(t5, i6, s5) {
      this.element = t5, this.type = 6, this._$AN = void 0, this._$AM = i6, this.options = s5;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    _$AI(t5) {
      M2(this, t5);
    }
  };
  var B2 = t3.litHtmlPolyfillSupport;
  B2?.(S3, k2), (t3.litHtmlVersions ?? (t3.litHtmlVersions = [])).push("3.3.3");
  var D = (t5, i6, s5) => {
    const e6 = s5?.renderBefore ?? i6;
    let h4 = e6._$litPart$;
    if (void 0 === h4) {
      const t6 = s5?.renderBefore ?? null;
      e6._$litPart$ = h4 = new k2(i6.insertBefore(c4(), t6), t6, void 0, s5 ?? {});
    }
    return h4._$AI(t5), h4;
  };

  // ../node_modules/.pnpm/lit-element@4.2.2/node_modules/lit-element/lit-element.js
  var s4 = globalThis;
  var i5 = class extends y {
    constructor() {
      super(...arguments), this.renderOptions = { host: this }, this._$Do = void 0;
    }
    createRenderRoot() {
      var _a;
      const t5 = super.createRenderRoot();
      return (_a = this.renderOptions).renderBefore ?? (_a.renderBefore = t5.firstChild), t5;
    }
    update(t5) {
      const r6 = this.render();
      this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(t5), this._$Do = D(r6, this.renderRoot, this.renderOptions);
    }
    connectedCallback() {
      super.connectedCallback(), this._$Do?.setConnected(true);
    }
    disconnectedCallback() {
      super.disconnectedCallback(), this._$Do?.setConnected(false);
    }
    render() {
      return E2;
    }
  };
  i5._$litElement$ = true, i5["finalized"] = true, s4.litElementHydrateSupport?.({ LitElement: i5 });
  var o5 = s4.litElementPolyfillSupport;
  o5?.({ LitElement: i5 });
  (s4.litElementVersions ?? (s4.litElementVersions = [])).push("4.2.2");

  // ../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/decorators/custom-element.js
  var t4 = (t5) => (e6, o7) => {
    void 0 !== o7 ? o7.addInitializer(() => {
      customElements.define(t5, e6);
    }) : customElements.define(t5, e6);
  };

  // ../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/decorators/property.js
  var o6 = { attribute: true, type: String, converter: u, reflect: false, hasChanged: f };
  var r5 = (t5 = o6, e6, r6) => {
    const { kind: n6, metadata: i6 } = r6;
    let s5 = globalThis.litPropertyMetadata.get(i6);
    if (void 0 === s5 && globalThis.litPropertyMetadata.set(i6, s5 = /* @__PURE__ */ new Map()), "setter" === n6 && ((t5 = Object.create(t5)).wrapped = true), s5.set(r6.name, t5), "accessor" === n6) {
      const { name: o7 } = r6;
      return { set(r7) {
        const n7 = e6.get.call(this);
        e6.set.call(this, r7), this.requestUpdate(o7, n7, t5, true, r7);
      }, init(e7) {
        return void 0 !== e7 && this.C(o7, void 0, t5, e7), e7;
      } };
    }
    if ("setter" === n6) {
      const { name: o7 } = r6;
      return function(r7) {
        const n7 = this[o7];
        e6.call(this, r7), this.requestUpdate(o7, n7, t5, true, r7);
      };
    }
    throw Error("Unsupported decorator location: " + n6);
  };
  function n5(t5) {
    return (e6, o7) => "object" == typeof o7 ? r5(t5, e6, o7) : ((t6, e7, o8) => {
      const r6 = e7.hasOwnProperty(o8);
      return e7.constructor.createProperty(o8, t6), r6 ? Object.getOwnPropertyDescriptor(e7, o8) : void 0;
    })(t5, e6, o7);
  }

  // src/ui/components/world-environment/skybox.ts
  var SKY_THEMES = {
    night: {
      "--we-sky-center": "#0a0a12",
      "--we-sky-edge": "#000000",
      "--we-wash": "rgba(212,175,55,0.05)",
      "--we-neb-a": "rgba(212,175,55,0.22)",
      // gold
      "--we-neb-b": "rgba(245,200,90,0.16)",
      // amber
      "--we-neb-c": "rgba(60,90,200,0.20)"
      // deep blue
    },
    dusk: {
      "--we-sky-center": "#140d16",
      "--we-sky-edge": "#040208",
      "--we-wash": "rgba(255,150,90,0.06)",
      "--we-neb-a": "rgba(255,140,80,0.22)",
      "--we-neb-b": "rgba(212,120,160,0.18)",
      "--we-neb-c": "rgba(90,70,180,0.20)"
    },
    dawn: {
      "--we-sky-center": "#10141c",
      "--we-sky-edge": "#020409",
      "--we-wash": "rgba(140,200,255,0.06)",
      "--we-neb-a": "rgba(120,200,255,0.20)",
      "--we-neb-b": "rgba(245,210,140,0.16)",
      "--we-neb-c": "rgba(110,90,210,0.18)"
    }
  };
  var skyboxStyles = i`
  .we-sky {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    /* Base: deep radial gradient (center → edges). */
    background: radial-gradient(
      120% 120% at 50% 45%,
      var(--we-sky-center, #0a0a12) 0%,
      #060608 55%,
      var(--we-sky-edge, #000000) 100%
    );
  }

  /* Mid: faint holographic wash, slowly rotating. */
  .we-wash {
    position: absolute;
    inset: -40%;
    background: conic-gradient(
      from 0deg at 50% 50%,
      transparent 0deg,
      var(--we-wash, rgba(212, 175, 55, 0.05)) 60deg,
      transparent 140deg,
      var(--we-wash, rgba(212, 175, 55, 0.05)) 240deg,
      transparent 320deg
    );
    mix-blend-mode: screen;
    animation: we-wash-spin 32s linear infinite;
    will-change: transform;
  }
  @keyframes we-wash-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Nebulae: large soft blurred blobs drifting very slowly. */
  .we-neb {
    position: absolute;
    border-radius: 50%;
    filter: blur(60px);
    mix-blend-mode: screen;
    will-change: transform, opacity;
  }
  .we-neb.a {
    width: 46%;
    height: 46%;
    left: 8%;
    top: 14%;
    background: radial-gradient(circle, var(--we-neb-a) 0%, transparent 70%);
    animation: we-neb-a 46s ease-in-out infinite;
  }
  .we-neb.b {
    width: 38%;
    height: 38%;
    right: 6%;
    top: 30%;
    background: radial-gradient(circle, var(--we-neb-b) 0%, transparent 70%);
    animation: we-neb-b 58s ease-in-out infinite;
  }
  .we-neb.c {
    width: 52%;
    height: 52%;
    left: 26%;
    bottom: 2%;
    background: radial-gradient(circle, var(--we-neb-c) 0%, transparent 70%);
    animation: we-neb-c 64s ease-in-out infinite;
  }
  @keyframes we-neb-a {
    0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.85; }
    50% { transform: translate(6%, -4%) scale(1.12); opacity: 1; }
  }
  @keyframes we-neb-b {
    0%, 100% { transform: translate(0, 0) scale(1.05); opacity: 0.7; }
    50% { transform: translate(-5%, 5%) scale(0.95); opacity: 0.95; }
  }
  @keyframes we-neb-c {
    0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.6; }
    50% { transform: translate(4%, -6%) scale(1.1); opacity: 0.85; }
  }

  /* Parallax star layers. Each multiplies the host pan by its depth factor. */
  .we-stars {
    position: absolute;
    inset: -10%;
    will-change: transform;
  }
  .we-stars.far {
    transform: translate(
      calc(var(--we-pan-x, 0px) * 0.15),
      calc(var(--we-pan-y, 0px) * 0.15)
    );
  }
  .we-stars.mid {
    transform: translate(
      calc(var(--we-pan-x, 0px) * 0.45),
      calc(var(--we-pan-y, 0px) * 0.45)
    );
  }
  .we-stars.near {
    transform: translate(
      calc(var(--we-pan-x, 0px) * 0.9),
      calc(var(--we-pan-y, 0px) * 0.9)
    );
  }
  .we-star {
    position: absolute;
    border-radius: 50%;
    background: #fff;
    animation: we-twinkle var(--tw, 4s) ease-in-out infinite;
    animation-delay: var(--td, 0s);
    will-change: opacity, transform;
  }
  @keyframes we-twinkle {
    0%, 100% { opacity: var(--o0, 0.25); transform: scale(0.85); }
    50% { opacity: var(--o1, 0.95); transform: scale(1.15); }
  }

  @media (prefers-reduced-motion: reduce) {
    .we-wash,
    .we-neb,
    .we-star {
      animation: none !important;
    }
  }
`;
  function makeStars(count, sizeRange, rnd) {
    const out = [];
    for (let i6 = 0; i6 < count; i6++) {
      const s5 = sizeRange[0] + rnd() * (sizeRange[1] - sizeRange[0]);
      out.push({
        x: rnd() * 100,
        y: rnd() * 100,
        s: s5,
        tw: 2.5 + rnd() * 4.5,
        td: -rnd() * 5,
        o0: 0.12 + rnd() * 0.25,
        o1: 0.6 + rnd() * 0.4
      });
    }
    return out;
  }
  function starLayer(cls, stars) {
    return b3`<div class="we-stars ${cls}">
    ${stars.map(
      (st) => b3`<span
        class="we-star"
        style="left:${st.x}%;top:${st.y}%;width:${st.s}px;height:${st.s}px;--tw:${st.tw}s;--td:${st.td}s;--o0:${st.o0};--o1:${st.o1}"
      ></span>`
    )}
  </div>`;
  }
  function buildStarLayers(rnd = Math.random) {
    return [
      starLayer("far", makeStars(55, [1, 1.6], rnd)),
      starLayer("mid", makeStars(40, [1.4, 2.2], rnd)),
      starLayer("near", makeStars(25, [2, 3.2], rnd))
    ];
  }
  function renderSky(starLayers) {
    return b3`
    <div class="we-sky">
      <div class="we-wash"></div>
      <div class="we-neb a"></div>
      <div class="we-neb b"></div>
      <div class="we-neb c"></div>
      ${starLayers}
    </div>
  `;
  }

  // src/ui/components/world-environment/ground-grid.ts
  var groundGridStyles = i`
  .we-floor {
    position: absolute;
    left: 50%;
    top: 52%;
    width: 240%;
    height: 240%;
    /* Lay the plane down into the scene + rotate 45° so cells read as iso diamonds. */
    transform: translate(-50%, -50%) perspective(900px) rotateX(62deg) rotateZ(45deg);
    transform-origin: center center;
    pointer-events: none;
    /* Fade the far edges so the floor melts into the sky. */
    -webkit-mask-image: radial-gradient(60% 60% at 50% 50%, #000 38%, transparent 78%);
    mask-image: radial-gradient(60% 60% at 50% 50%, #000 38%, transparent 78%);
  }

  /* The static grid: cells + hex-hint diagonals + gold intersection nodes. */
  .we-grid {
    position: absolute;
    inset: 0;
    --cell: 68px;
    --line: rgba(120, 150, 210, calc(0.10 + 0.22 * var(--we-activity, 0.3)));
    --diag: rgba(110, 140, 200, calc(0.04 + 0.10 * var(--we-activity, 0.3)));
    --node: rgba(212, 175, 55, calc(0.45 + 0.5 * var(--we-activity, 0.3)));
    background-image:
      /* gold nodes at intersections */
      radial-gradient(circle at 0 0, var(--node) 0, var(--node) 2.1px, transparent 3px),
      /* hex-hint diagonals */
      repeating-linear-gradient(60deg, var(--diag) 0 1px, transparent 1px var(--cell)),
      repeating-linear-gradient(-60deg, var(--diag) 0 1px, transparent 1px var(--cell)),
      /* primary cell lines */
      linear-gradient(var(--line) 1px, transparent 1px),
      linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size:
      var(--cell) var(--cell),
      var(--cell) var(--cell),
      var(--cell) var(--cell),
      var(--cell) var(--cell),
      var(--cell) var(--cell);
    background-position:
      0 0,
      0 0,
      0 0,
      0 0,
      0 0;
  }

  /* Soft core glow under the atrium centre so the floor never feels empty. */
  .we-floor-core {
    position: absolute;
    inset: 0;
    mix-blend-mode: screen;
    background: radial-gradient(
      circle at 50% 50%,
      rgba(212, 175, 55, calc(0.10 + 0.22 * var(--we-activity, 0.3))) 0%,
      rgba(212, 175, 55, calc(0.04 + 0.08 * var(--we-activity, 0.3))) 14%,
      transparent 40%
    );
  }

  /* Additive pulse ring sweeping outward — brightens the lines it crosses. */
  .we-grid-pulse {
    position: absolute;
    inset: 0;
    mix-blend-mode: screen;
    background: radial-gradient(
      circle at 50% 50%,
      transparent 0%,
      transparent var(--r0, 0%),
      rgba(212, 175, 55, calc(0.18 + 0.5 * var(--we-activity, 0.3))) var(--r1, 8%),
      transparent var(--r2, 22%)
    );
    animation: we-pulse var(--we-pulse-speed, 4s) ease-out infinite;
    will-change: background;
  }
  /* Second, offset wave so the floor never feels static. */
  .we-grid-pulse.b {
    animation-delay: calc(var(--we-pulse-speed, 4s) * -0.5);
    opacity: 0.7;
  }
  @keyframes we-pulse {
    0% {
      --r0: 0%;
      --r1: 3%;
      --r2: 12%;
      opacity: calc(0.2 + 0.7 * var(--we-activity, 0.3));
    }
    100% {
      --r0: 60%;
      --r1: 72%;
      --r2: 92%;
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .we-grid-pulse {
      animation: none;
      opacity: 0.25;
      background: radial-gradient(
        circle at 50% 50%,
        rgba(212, 175, 55, 0.12) 0%,
        transparent 45%
      );
    }
  }
`;
  var registered = false;
  function registerGridProps() {
    if (registered) return;
    registered = true;
    const reg = CSS.registerProperty;
    if (typeof reg !== "function") return;
    for (const name of ["--r0", "--r1", "--r2"]) {
      try {
        reg.call(CSS, { name, syntax: "<percentage>", inherits: false, initialValue: "0%" });
      } catch {
      }
    }
  }
  function renderGround() {
    return b3`
    <div class="we-floor">
      <div class="we-floor-core"></div>
      <div class="we-grid"></div>
      <div class="we-grid-pulse"></div>
      <div class="we-grid-pulse b"></div>
    </div>
  `;
  }

  // src/ui/components/world-environment/conduit-beams.ts
  var GOLD = "#d4af37";
  function rgba(hex, a4) {
    let h4 = hex.replace("#", "");
    if (h4.length === 3) h4 = h4.split("").map((c5) => c5 + c5).join("");
    const n6 = parseInt(h4, 16);
    return `rgba(${n6 >> 16 & 255}, ${n6 >> 8 & 255}, ${n6 & 255}, ${a4})`;
  }
  var ConduitBeams = class {
    constructor(canvas) {
      this.beams = /* @__PURE__ */ new Map();
      this.particles = [];
      this.raf = 0;
      this.last = 0;
      this.seq = 0;
      this.activity = 0.3;
      this.reduced = false;
      this.w = 0;
      this.h = 0;
      this.dpr = 1;
      this.canvas = canvas;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("conduit-beams: 2d context unavailable");
      this.ctx = ctx;
      this.reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    setActivity(v3) {
      this.activity = Math.max(0, Math.min(1, v3));
    }
    addBeam(spec) {
      const id = `beam_${++this.seq}`;
      this.beams.set(id, {
        id,
        from: spec.from,
        to: spec.to,
        intensity: Math.max(0, Math.min(1, spec.intensity ?? 0.5)),
        color: spec.color ?? GOLD,
        phase: 0,
        burstAccum: 0
      });
      return id;
    }
    updateBeam(id, spec) {
      const b4 = this.beams.get(id);
      if (!b4) return;
      if (spec.from) b4.from = spec.from;
      if (spec.to) b4.to = spec.to;
      if (spec.intensity != null) b4.intensity = Math.max(0, Math.min(1, spec.intensity));
      if (spec.color) b4.color = spec.color;
    }
    removeBeam(id) {
      this.beams.delete(id);
    }
    clear() {
      this.beams.clear();
      this.particles.length = 0;
    }
    /** Replace the full beam set (used by the `world-env:beams` event). */
    setBeams(specs) {
      this.clear();
      for (const s5 of specs) this.addBeam(s5);
    }
    resize(cssW, cssH) {
      this.dpr = Math.min(2, typeof devicePixelRatio === "number" && devicePixelRatio || 1);
      this.w = cssW;
      this.h = cssH;
      this.canvas.width = Math.max(1, Math.round(cssW * this.dpr));
      this.canvas.height = Math.max(1, Math.round(cssH * this.dpr));
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
    }
    start() {
      if (this.raf) return;
      const loop = (t5) => {
        const dt = this.last ? Math.min(64, t5 - this.last) : 16;
        this.last = t5;
        this.step(dt / 1e3);
        this.draw();
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
    stop() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.last = 0;
    }
    step(dt) {
      const act = this.activity;
      for (const b4 of this.beams.values()) {
        const speed = 0.25 + 1.4 * b4.intensity * (0.4 + 0.6 * act);
        b4.phase = (b4.phase + speed * dt) % 1;
        if (!this.reduced) {
          b4.burstAccum += dt * (2 + 10 * b4.intensity);
          while (b4.burstAccum >= 1) {
            b4.burstAccum -= 1;
            this.spawnBurst(b4);
          }
        }
      }
      for (let i6 = this.particles.length - 1; i6 >= 0; i6--) {
        const p4 = this.particles[i6];
        p4.life -= dt;
        if (p4.life <= 0) {
          this.particles.splice(i6, 1);
          continue;
        }
        p4.x += p4.vx * dt;
        p4.y += p4.vy * dt;
        p4.vx *= 0.92;
        p4.vy *= 0.92;
      }
    }
    spawnBurst(b4) {
      const end = Math.random() < 0.5 ? b4.from : b4.to;
      const x3 = end.x * this.w;
      const y4 = end.y * this.h;
      const n6 = 1 + Math.floor(2 * b4.intensity);
      for (let i6 = 0; i6 < n6; i6++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 6 + Math.random() * 26 * b4.intensity;
        this.particles.push({
          x: x3,
          y: y4,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          life: 0.4 + Math.random() * 0.5,
          max: 0.9,
          color: b4.color
        });
      }
    }
    draw() {
      const { ctx, w: w3, h: h4, dpr } = this;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w3, h4);
      ctx.globalCompositeOperation = "lighter";
      for (const b4 of this.beams.values()) {
        const x1 = b4.from.x * w3;
        const y1 = b4.from.y * h4;
        const x22 = b4.to.x * w3;
        const y22 = b4.to.y * h4;
        const len = Math.hypot(x22 - x1, y22 - y1) || 1;
        const inten = b4.intensity * (0.45 + 0.55 * this.activity);
        ctx.strokeStyle = rgba(b4.color, 0.05 + 0.12 * inten);
        ctx.lineWidth = 7 + 8 * inten;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x22, y22);
        ctx.stroke();
        ctx.strokeStyle = rgba(b4.color, 0.12 + 0.2 * inten);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const grad = ctx.createLinearGradient(x1, y1, x22, y22);
        const head = rgba(b4.color, 0.85 * (0.4 + 0.6 * inten));
        grad.addColorStop(0, rgba(b4.color, 0));
        grad.addColorStop(0.5, head);
        grad.addColorStop(1, rgba(b4.color, 0));
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.5;
        const dash = Math.max(8, 22 - 12 * b4.intensity);
        ctx.setLineDash([dash, dash * 1.6]);
        ctx.lineDashOffset = -b4.phase * (dash * 2.6) - len % (dash * 2.6);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x22, y22);
        ctx.stroke();
        ctx.setLineDash([]);
        for (const e6 of [b4.from, b4.to]) {
          const ex = e6.x * w3;
          const ey = e6.y * h4;
          const r6 = 2 + 3 * inten;
          const g3 = ctx.createRadialGradient(ex, ey, 0, ex, ey, r6 * 3.5);
          g3.addColorStop(0, rgba(b4.color, 0.9));
          g3.addColorStop(0.4, rgba(b4.color, 0.35));
          g3.addColorStop(1, rgba(b4.color, 0));
          ctx.fillStyle = g3;
          ctx.beginPath();
          ctx.arc(ex, ey, r6 * 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      for (const p4 of this.particles) {
        const a4 = Math.max(0, p4.life / p4.max);
        ctx.fillStyle = rgba(p4.color, 0.7 * a4);
        ctx.beginPath();
        ctx.arc(p4.x, p4.y, 1.5 * a4 + 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    }
  };

  // src/ui/components/world-environment.ts
  var WorldEnvironment = class extends i5 {
    constructor() {
      super(...arguments);
      this.activity = 0.3;
      this.skyTheme = "night";
      this.beamsAttr = null;
      this.stars = buildStarLayers();
      this.beams = null;
      this.ro = null;
      this.demoTimer = 0;
      this.demoActive = false;
      this.gotExternalActivity = false;
      this.gotExternalBeams = false;
      this.panX = 0;
      this.panY = 0;
      // ── event handlers ───────────────────────────────────────────────────────────
      this.onActivityEvt = (e6) => {
        if (typeof e6.detail === "number") this.setActivity(e6.detail);
      };
      this.onBeamsEvt = (e6) => {
        if (Array.isArray(e6.detail)) this.setBeams(e6.detail);
      };
      this.onBeamAddEvt = (e6) => {
        if (e6.detail?.from && e6.detail?.to) this.addBeam(e6.detail);
      };
      this.onBeamRemoveEvt = (e6) => {
        if (e6.detail?.id) this.removeBeam(e6.detail.id);
      };
      this.onPanEvt = (e6) => {
        if (e6.detail) this.setPan(e6.detail.x ?? 0, e6.detail.y ?? 0);
      };
      this.onPointerMove = (e6) => {
        const r6 = this.getBoundingClientRect();
        const nx = (e6.clientX - r6.left) / (r6.width || 1) - 0.5;
        const ny = (e6.clientY - r6.top) / (r6.height || 1) - 0.5;
        this.setPan(nx * -40, ny * -28);
      };
    }
    connectedCallback() {
      super.connectedCallback();
      registerGridProps();
      window.addEventListener("world-env:activity", this.onActivityEvt);
      window.addEventListener("world-env:beams", this.onBeamsEvt);
      window.addEventListener("world-env:beam-add", this.onBeamAddEvt);
      window.addEventListener("world-env:beam-remove", this.onBeamRemoveEvt);
      window.addEventListener("world-env:pan", this.onPanEvt);
    }
    disconnectedCallback() {
      super.disconnectedCallback();
      window.removeEventListener("world-env:activity", this.onActivityEvt);
      window.removeEventListener("world-env:beams", this.onBeamsEvt);
      window.removeEventListener("world-env:beam-add", this.onBeamAddEvt);
      window.removeEventListener("world-env:beam-remove", this.onBeamRemoveEvt);
      window.removeEventListener("world-env:pan", this.onPanEvt);
      this.ro?.disconnect();
      this.beams?.stop();
      if (this.demoTimer) clearInterval(this.demoTimer);
    }
    firstUpdated() {
      this.applyTheme();
      this.applyActivity();
      const canvas = this.renderRoot.querySelector("canvas");
      if (canvas) {
        this.beams = new ConduitBeams(canvas);
        this.beams.setActivity(this.activity);
        this.syncCanvasSize();
        this.beams.start();
      }
      this.ro = new ResizeObserver(() => this.syncCanvasSize());
      this.ro.observe(this);
      this.addEventListener("pointermove", this.onPointerMove);
      if (this.beamsAttr) this.applyBeamsAttr();
      this.scheduleDemo();
    }
    updated(changed) {
      if (changed.has("activity")) this.applyActivity();
      if (changed.has("skyTheme")) this.applyTheme();
      if (changed.has("beamsAttr")) this.applyBeamsAttr();
    }
    // ── Public API ──────────────────────────────────────────────────────────────
    setActivity(v3) {
      this.gotExternalActivity = true;
      this.stopDemo();
      this.activity = Math.max(0, Math.min(1, v3));
      this.applyActivity();
    }
    addBeam(spec) {
      this.gotExternalBeams = true;
      this.stopDemo();
      return this.beams?.addBeam(spec) ?? "";
    }
    removeBeam(id) {
      this.beams?.removeBeam(id);
    }
    setBeams(specs) {
      this.gotExternalBeams = true;
      this.stopDemo();
      this.beams?.setBeams(specs);
    }
    setSkyTheme(theme) {
      this.skyTheme = theme;
      this.applyTheme();
    }
    // ── internals ────────────────────────────────────────────────────────────────
    applyActivity() {
      const a4 = Math.max(0, Math.min(1, this.activity));
      this.style.setProperty("--we-activity", String(a4));
      this.style.setProperty("--we-pulse-speed", `${(5.5 - 3.3 * a4).toFixed(2)}s`);
      this.beams?.setActivity(a4);
    }
    applyTheme() {
      const pal = SKY_THEMES[this.skyTheme] ?? SKY_THEMES.night;
      for (const [k3, v3] of Object.entries(pal)) this.style.setProperty(k3, v3);
    }
    applyBeamsAttr() {
      if (!this.beamsAttr || !this.beams) return;
      try {
        const specs = JSON.parse(this.beamsAttr);
        if (Array.isArray(specs)) this.setBeams(specs);
      } catch {
      }
    }
    syncCanvasSize() {
      const r6 = this.getBoundingClientRect();
      this.beams?.resize(r6.width || 800, r6.height || 480);
    }
    setPan(x3, y4) {
      this.panX = x3;
      this.panY = y4;
      this.style.setProperty("--we-pan-x", `${x3}px`);
      this.style.setProperty("--we-pan-y", `${y4}px`);
    }
    // ── ambient demo (when host feeds nothing) ────────────────────────────────────
    scheduleDemo() {
      window.setTimeout(() => {
        if (!this.gotExternalActivity && !this.gotExternalBeams) this.startDemo();
      }, 1500);
    }
    startDemo() {
      if (this.demoActive) return;
      this.demoActive = true;
      if (!this.gotExternalBeams && this.beams) {
        const cx = 0.5;
        const cy = 0.54;
        const spokes = 6;
        const demo = [];
        for (let i6 = 0; i6 < spokes; i6++) {
          const ang = i6 / spokes * Math.PI * 2 + 0.4;
          demo.push({
            from: { x: cx, y: cy },
            to: { x: cx + Math.cos(ang) * 0.34, y: cy + Math.sin(ang) * 0.3 },
            intensity: 0.3 + i6 % 3 * 0.25,
            color: i6 % 2 ? "#d4af37" : "#7dd3fc"
          });
        }
        this.beams.setBeams(demo);
      }
      if (!this.gotExternalActivity) {
        let t5 = 0;
        this.demoTimer = window.setInterval(() => {
          t5 += 0.4;
          const a4 = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(t5));
          this.activity = a4;
          this.applyActivity();
        }, 400);
      }
    }
    stopDemo() {
      if (!this.demoActive) return;
      this.demoActive = false;
      if (this.demoTimer) {
        clearInterval(this.demoTimer);
        this.demoTimer = 0;
      }
    }
    render() {
      return b3`
      ${renderSky(this.stars)}
      ${renderGround()}
      <canvas class="we-beams"></canvas>
    `;
    }
  };
  WorldEnvironment.styles = [
    i`
      :host {
        display: block;
        position: relative;
        inset: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        pointer-events: none;
        background: #000;
      }
      .we-beams {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }
    `,
    skyboxStyles,
    groundGridStyles
  ];
  __decorateClass([
    n5({ type: Number })
  ], WorldEnvironment.prototype, "activity", 2);
  __decorateClass([
    n5({ type: String, attribute: "sky-theme" })
  ], WorldEnvironment.prototype, "skyTheme", 2);
  __decorateClass([
    n5({ attribute: "beams" })
  ], WorldEnvironment.prototype, "beamsAttr", 2);
  WorldEnvironment = __decorateClass([
    t4("world-environment")
  ], WorldEnvironment);

  // src/ui/components/world-environment/__test.entry.ts
  var env = document.createElement("world-environment");
  env.id = "env";
  env.setAttribute("style", "position:absolute;inset:0;z-index:0");
  document.getElementById("stage").appendChild(env);
  var viz = document.createElement("div");
  viz.id = "mockviz";
  viz.setAttribute(
    "style",
    "position:absolute;inset:0;z-index:1;display:none;pointer-events:none;background:radial-gradient(40% 30% at 50% 54%, rgba(20,30,60,0.0), transparent 70%);"
  );
  viz.innerHTML = `
  <div style="position:absolute;left:50%;top:54%;transform:translate(-50%,-50%);
    width:120px;height:60px;border:1px solid rgba(212,175,55,.6);border-radius:8px;
    background:rgba(10,14,26,.55);color:#d4af37;font:12px monospace;display:grid;
    place-items:center;box-shadow:0 0 30px rgba(212,175,55,.25)">ATRIUM CORE</div>
  <div style="position:absolute;left:24%;top:32%;width:34px;height:34px;border-radius:6px;
    background:rgba(125,211,252,.18);border:1px solid rgba(125,211,252,.5)"></div>
  <div style="position:absolute;left:70%;top:64%;width:34px;height:34px;border-radius:6px;
    background:rgba(167,139,250,.18);border:1px solid rgba(167,139,250,.5)"></div>
`;
  document.getElementById("stage").appendChild(viz);
  window.__we = {
    env,
    showViz(on) {
      viz.style.display = on ? "block" : "none";
    },
    setActivity(v3) {
      env.setActivity(v3);
    },
    setTheme(t5) {
      env.setSkyTheme(t5);
    },
    addDemoBeams() {
      const cx = 0.5, cy = 0.54;
      const specs = [];
      for (let i6 = 0; i6 < 7; i6++) {
        const a4 = i6 / 7 * Math.PI * 2 + 0.3;
        specs.push({
          from: { x: cx, y: cy },
          to: { x: cx + Math.cos(a4) * 0.36, y: cy + Math.sin(a4) * 0.32 },
          intensity: 0.3 + i6 % 3 * 0.3,
          color: i6 % 2 ? "#d4af37" : "#7dd3fc"
        });
      }
      env.setBeams(specs);
    }
  };
})();
/*! Bundled license information:

@lit/reactive-element/css-tag.js:
  (**
   * @license
   * Copyright 2019 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

@lit/reactive-element/reactive-element.js:
lit-html/lit-html.js:
lit-html/lit-html.js:
lit-element/lit-element.js:
@lit/reactive-element/decorators/custom-element.js:
@lit/reactive-element/decorators/property.js:
@lit/reactive-element/decorators/state.js:
@lit/reactive-element/decorators/event-options.js:
@lit/reactive-element/decorators/base.js:
@lit/reactive-element/decorators/query.js:
@lit/reactive-element/decorators/query-all.js:
@lit/reactive-element/decorators/query-async.js:
@lit/reactive-element/decorators/query-assigned-nodes.js:
  (**
   * @license
   * Copyright 2017 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

lit-html/is-server.js:
  (**
   * @license
   * Copyright 2022 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

@lit/reactive-element/decorators/query-assigned-elements.js:
  (**
   * @license
   * Copyright 2021 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)
*/
