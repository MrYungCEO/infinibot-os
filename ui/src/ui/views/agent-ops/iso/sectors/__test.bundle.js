"use strict";
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
  Symbol.metadata ??= /* @__PURE__ */ Symbol("metadata"), a.litPropertyMetadata ??= /* @__PURE__ */ new WeakMap();
  var y = class extends HTMLElement {
    static addInitializer(t5) {
      this._$Ei(), (this.l ??= []).push(t5);
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
      const { get: e6, set: r7 } = h(this.prototype, t5) ?? { get() {
        return this[s5];
      }, set(t6) {
        this[s5] = t6;
      } };
      return { get: e6, set(s6) {
        const h4 = e6?.call(this);
        r7?.call(this, s6), this.requestUpdate(t5, h4, i6);
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
      (this._$EO ??= /* @__PURE__ */ new Set()).add(t5), void 0 !== this.renderRoot && this.isConnected && t5.hostConnected?.();
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
      this.renderRoot ??= this.createRenderRoot(), this.enableUpdating(true), this._$EO?.forEach((t5) => t5.hostConnected?.());
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
        const r7 = h4.fromAttribute(s5, t6.type);
        this[e6] = r7 ?? this._$Ej?.get(e6) ?? r7, this._$Em = null;
      }
    }
    requestUpdate(t5, s5, i6, e6 = false, h4) {
      if (void 0 !== t5) {
        const r7 = this.constructor;
        if (false === e6 && (h4 = this[t5]), i6 ??= r7.getPropertyOptions(t5), !((i6.hasChanged ?? f)(h4, s5) || i6.useDefault && i6.reflect && h4 === this._$Ej?.get(t5) && !this.hasAttribute(r7._$Eu(t5, i6)))) return;
        this.C(t5, s5, i6);
      }
      false === this.isUpdatePending && (this._$ES = this._$EP());
    }
    C(t5, s5, { useDefault: i6, reflect: e6, wrapped: h4 }, r7) {
      i6 && !(this._$Ej ??= /* @__PURE__ */ new Map()).has(t5) && (this._$Ej.set(t5, r7 ?? s5 ?? this[t5]), true !== h4 || void 0 !== r7) || (this._$AL.has(t5) || (this.hasUpdated || i6 || (s5 = void 0), this._$AL.set(t5, s5)), true === e6 && this._$Em !== t5 && (this._$Eq ??= /* @__PURE__ */ new Set()).add(t5));
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
        if (this.renderRoot ??= this.createRenderRoot(), this._$Ep) {
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
      this._$Eq &&= this._$Eq.forEach((t6) => this._$ET(t6, this[t6])), this._$EM();
    }
    updated(t5) {
    }
    firstUpdated(t5) {
    }
  };
  y.elementStyles = [], y.shadowRootOptions = { mode: "open" }, y[d("elementProperties")] = /* @__PURE__ */ new Map(), y[d("finalized")] = /* @__PURE__ */ new Map(), p?.({ ReactiveElement: y }), (a.reactiveElementVersions ??= []).push("2.1.2");

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
      let r7;
      this.parts = [];
      let l4 = 0, a4 = 0;
      const u4 = t5.length - 1, d4 = this.parts, [f4, v3] = N(t5, i6);
      if (this.el = _S.createElement(f4, e6), P.currentNode = this.el.content, 2 === i6 || 3 === i6) {
        const t6 = this.el.content.firstChild;
        t6.replaceWith(...t6.childNodes);
      }
      for (; null !== (r7 = P.nextNode()) && d4.length < u4; ) {
        if (1 === r7.nodeType) {
          if (r7.hasAttributes()) for (const t6 of r7.getAttributeNames()) if (t6.endsWith(h2)) {
            const i7 = v3[a4++], s5 = r7.getAttribute(t6).split(o3), e7 = /([.?@])?(.*)/.exec(i7);
            d4.push({ type: 1, index: l4, name: e7[2], strings: s5, ctor: "." === e7[1] ? I : "?" === e7[1] ? L : "@" === e7[1] ? z : H }), r7.removeAttribute(t6);
          } else t6.startsWith(o3) && (d4.push({ type: 6, index: l4 }), r7.removeAttribute(t6));
          if (y2.test(r7.tagName)) {
            const t6 = r7.textContent.split(o3), i7 = t6.length - 1;
            if (i7 > 0) {
              r7.textContent = s2 ? s2.emptyScript : "";
              for (let s5 = 0; s5 < i7; s5++) r7.append(t6[s5], c3()), P.nextNode(), d4.push({ type: 2, index: ++l4 });
              r7.append(t6[i7], c3());
            }
          }
        } else if (8 === r7.nodeType) if (r7.data === n3) d4.push({ type: 2, index: l4 });
        else {
          let t6 = -1;
          for (; -1 !== (t6 = r7.data.indexOf(o3, t6 + 1)); ) d4.push({ type: 7, index: l4 }), t6 += o3.length - 1;
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
    return h4?.constructor !== o7 && (h4?._$AO?.(false), void 0 === o7 ? h4 = void 0 : (h4 = new o7(t5), h4._$AT(t5, s5, e6)), void 0 !== e6 ? (s5._$Co ??= [])[e6] = h4 : s5._$Cl = h4), void 0 !== h4 && (i6 = M(t5, h4._$AS(t5, i6.values), h4, e6)), i6;
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
      let h4 = P.nextNode(), o7 = 0, n6 = 0, r7 = s5[0];
      for (; void 0 !== r7; ) {
        if (o7 === r7.index) {
          let i7;
          2 === r7.type ? i7 = new k(h4, h4.nextSibling, this, t5) : 1 === r7.type ? i7 = new r7.ctor(h4, r7.name, r7.strings, this, t5) : 6 === r7.type && (i7 = new Z(h4, this, t5)), this._$AV.push(i7), r7 = s5[++n6];
        }
        o7 !== r7?.index && (h4 = P.nextNode(), o7++);
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
        let n6, r7;
        for (t5 = h4[0], n6 = 0; n6 < h4.length - 1; n6++) r7 = M(this, e7[s5 + n6], i6, n6), r7 === E && (r7 = this._$AH[n6]), o7 ||= !a2(r7) || r7 !== this._$AH[n6], r7 === A ? t5 = A : t5 !== A && (t5 += (r7 ?? "") + h4[n6 + 1]), this._$AH[n6] = r7;
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
  B?.(S2, k), (t2.litHtmlVersions ??= []).push("3.3.2");

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
      let r7;
      this.parts = [];
      let l4 = 0, a4 = 0;
      const u4 = t5.length - 1, d4 = this.parts, [f4, v3] = N2(t5, i6);
      if (this.el = _S.createElement(f4, e6), P2.currentNode = this.el.content, 2 === i6 || 3 === i6) {
        const t6 = this.el.content.firstChild;
        t6.replaceWith(...t6.childNodes);
      }
      for (; null !== (r7 = P2.nextNode()) && d4.length < u4; ) {
        if (1 === r7.nodeType) {
          if (r7.hasAttributes()) for (const t6 of r7.getAttributeNames()) if (t6.endsWith(h3)) {
            const i7 = v3[a4++], s5 = r7.getAttribute(t6).split(o4), e7 = /([.?@])?(.*)/.exec(i7);
            d4.push({ type: 1, index: l4, name: e7[2], strings: s5, ctor: "." === e7[1] ? I2 : "?" === e7[1] ? L2 : "@" === e7[1] ? z2 : H2 }), r7.removeAttribute(t6);
          } else t6.startsWith(o4) && (d4.push({ type: 6, index: l4 }), r7.removeAttribute(t6));
          if (y3.test(r7.tagName)) {
            const t6 = r7.textContent.split(o4), i7 = t6.length - 1;
            if (i7 > 0) {
              r7.textContent = s3 ? s3.emptyScript : "";
              for (let s5 = 0; s5 < i7; s5++) r7.append(t6[s5], c4()), P2.nextNode(), d4.push({ type: 2, index: ++l4 });
              r7.append(t6[i7], c4());
            }
          }
        } else if (8 === r7.nodeType) if (r7.data === n4) d4.push({ type: 2, index: l4 });
        else {
          let t6 = -1;
          for (; -1 !== (t6 = r7.data.indexOf(o4, t6 + 1)); ) d4.push({ type: 7, index: l4 }), t6 += o4.length - 1;
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
    return h4?.constructor !== o7 && (h4?._$AO?.(false), void 0 === o7 ? h4 = void 0 : (h4 = new o7(t5), h4._$AT(t5, s5, e6)), void 0 !== e6 ? (s5._$Co ??= [])[e6] = h4 : s5._$Cl = h4), void 0 !== h4 && (i6 = M2(t5, h4._$AS(t5, i6.values), h4, e6)), i6;
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
      let h4 = P2.nextNode(), o7 = 0, n6 = 0, r7 = s5[0];
      for (; void 0 !== r7; ) {
        if (o7 === r7.index) {
          let i7;
          2 === r7.type ? i7 = new k2(h4, h4.nextSibling, this, t5) : 1 === r7.type ? i7 = new r7.ctor(h4, r7.name, r7.strings, this, t5) : 6 === r7.type && (i7 = new Z2(h4, this, t5)), this._$AV.push(i7), r7 = s5[++n6];
        }
        o7 !== r7?.index && (h4 = P2.nextNode(), o7++);
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
        let n6, r7;
        for (t5 = h4[0], n6 = 0; n6 < h4.length - 1; n6++) r7 = M2(this, e7[s5 + n6], i6, n6), r7 === E2 && (r7 = this._$AH[n6]), o7 ||= !a3(r7) || r7 !== this._$AH[n6], r7 === A2 ? t5 = A2 : t5 !== A2 && (t5 += (r7 ?? "") + h4[n6 + 1]), this._$AH[n6] = r7;
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
  B2?.(S3, k2), (t3.litHtmlVersions ??= []).push("3.3.3");
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
      const t5 = super.createRenderRoot();
      return this.renderOptions.renderBefore ??= t5.firstChild, t5;
    }
    update(t5) {
      const r7 = this.render();
      this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(t5), this._$Do = D(r7, this.renderRoot, this.renderOptions);
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
  (s4.litElementVersions ??= []).push("4.2.2");

  // ../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/decorators/custom-element.js
  var t4 = (t5) => (e6, o7) => {
    void 0 !== o7 ? o7.addInitializer(() => {
      customElements.define(t5, e6);
    }) : customElements.define(t5, e6);
  };

  // ../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/decorators/property.js
  var o6 = { attribute: true, type: String, converter: u, reflect: false, hasChanged: f };
  var r5 = (t5 = o6, e6, r7) => {
    const { kind: n6, metadata: i6 } = r7;
    let s5 = globalThis.litPropertyMetadata.get(i6);
    if (void 0 === s5 && globalThis.litPropertyMetadata.set(i6, s5 = /* @__PURE__ */ new Map()), "setter" === n6 && ((t5 = Object.create(t5)).wrapped = true), s5.set(r7.name, t5), "accessor" === n6) {
      const { name: o7 } = r7;
      return { set(r8) {
        const n7 = e6.get.call(this);
        e6.set.call(this, r8), this.requestUpdate(o7, n7, t5, true, r8);
      }, init(e7) {
        return void 0 !== e7 && this.C(o7, void 0, t5, e7), e7;
      } };
    }
    if ("setter" === n6) {
      const { name: o7 } = r7;
      return function(r8) {
        const n7 = this[o7];
        e6.call(this, r8), this.requestUpdate(o7, n7, t5, true, r8);
      };
    }
    throw Error("Unsupported decorator location: " + n6);
  };
  function n5(t5) {
    return (e6, o7) => "object" == typeof o7 ? r5(t5, e6, o7) : ((t6, e7, o8) => {
      const r7 = e7.hasOwnProperty(o8);
      return e7.constructor.createProperty(o8, t6), r7 ? Object.getOwnPropertyDescriptor(e7, o8) : void 0;
    })(t5, e6, o7);
  }

  // ../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/decorators/state.js
  function r6(r7) {
    return n5({ ...r7, state: true, attribute: false });
  }

  // src/ui/components/world-atmosphere.ts
  var ANCHORS = [
    { hour: 2, phase: "deep-night", top: [4, 6, 16], bottom: [10, 14, 34], light: 0.1 },
    { hour: 6, phase: "dawn", top: [58, 70, 122], bottom: [232, 168, 124], light: 0.55 },
    { hour: 12, phase: "day", top: [150, 196, 255], bottom: [210, 232, 255], light: 1 },
    { hour: 18.5, phase: "dusk", top: [74, 44, 94], bottom: [255, 126, 95], light: 0.5 },
    { hour: 21.5, phase: "night", top: [10, 18, 48], bottom: [22, 30, 66], light: 0.24 }
  ];
  var PHASE_HOUR = {
    "deep-night": 2,
    dawn: 6,
    day: 12,
    dusk: 18.5,
    night: 21.5
  };
  var PHASES = ["dawn", "day", "dusk", "night", "deep-night"];
  var lerp = (a4, b4, t5) => a4 + (b4 - a4) * t5;
  var rgb = (c5) => `rgb(${c5.map(Math.round).join(",")})`;
  function phaseForHour(hour) {
    if (hour >= 5 && hour < 8) return "dawn";
    if (hour >= 8 && hour < 17) return "day";
    if (hour >= 17 && hour < 20) return "dusk";
    if (hour >= 20 && hour < 22) return "night";
    return "deep-night";
  }
  function sample(hour) {
    const n6 = ANCHORS.length;
    let a4 = ANCHORS[n6 - 1];
    let b4 = ANCHORS[0];
    for (let i6 = 0; i6 < n6; i6++) {
      const cur = ANCHORS[i6];
      const nxt = ANCHORS[(i6 + 1) % n6];
      const start = cur.hour;
      const end = nxt.hour > cur.hour ? nxt.hour : nxt.hour + 24;
      const h4 = hour >= start ? hour : hour + 24;
      if (h4 >= start && h4 < end) {
        a4 = cur;
        b4 = nxt;
        const t5 = (h4 - start) / (end - start);
        const ease = t5 * t5 * (3 - 2 * t5);
        return {
          top: rgb([lerp(a4.top[0], b4.top[0], ease), lerp(a4.top[1], b4.top[1], ease), lerp(a4.top[2], b4.top[2], ease)]),
          bottom: rgb([lerp(a4.bottom[0], b4.bottom[0], ease), lerp(a4.bottom[1], b4.bottom[1], ease), lerp(a4.bottom[2], b4.bottom[2], ease)]),
          light: lerp(a4.light, b4.light, ease)
        };
      }
    }
    return { top: rgb(b4.top), bottom: rgb(b4.bottom), light: b4.light };
  }
  var WorldAtmosphere = class extends i5 {
    constructor() {
      super(...arguments);
      this.override = null;
      this._top = "rgb(150,196,255)";
      this._bottom = "rgb(210,232,255)";
      this._light = 1;
      this._phase = "day";
      this._timer = null;
      this._reduced = false;
    }
    /** Public read-only: ambient light level 0..1 (1 = bright noon). */
    get intensity() {
      return this._light;
    }
    connectedCallback() {
      super.connectedCallback();
      this._reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (this._reduced) this.setAttribute("data-reduced", "");
      this._tick();
      this._timer = window.setInterval(() => this._tick(), 3e4);
    }
    disconnectedCallback() {
      super.disconnectedCallback();
      if (this._timer != null) clearInterval(this._timer);
      this._timer = null;
    }
    updated(changed) {
      if (changed.has("override")) this._tick();
    }
    /** Freeze a phase for demos / screenshots, or pass null to resume the clock. */
    setTimeOverride(phase) {
      this.override = phase && PHASES.includes(phase) ? phase : null;
      this._tick();
    }
    currentPhase() {
      return this._phase;
    }
    /** Current fractional hour, honouring an active override. */
    _hour() {
      if (this.override) return PHASE_HOUR[this.override];
      const d4 = /* @__PURE__ */ new Date();
      return d4.getHours() + d4.getMinutes() / 60 + d4.getSeconds() / 3600;
    }
    _tick() {
      const hour = this._hour();
      const s5 = sample(hour);
      const phase = this.override ?? phaseForHour(hour);
      const prev = this._phase;
      this._top = s5.top;
      this._bottom = s5.bottom;
      this._light = s5.light;
      this._phase = phase;
      const isNight = phase === "deep-night";
      const lightsOn = phase === "dusk" || phase === "night" || phase === "deep-night";
      window.__worldIsNight = isNight;
      window.__worldLightsOn = lightsOn;
      document.documentElement.dataset.worldLights = lightsOn ? "on" : "off";
      document.documentElement.dataset.worldPhase = phase;
      if (phase !== prev) {
        window.dispatchEvent(
          new CustomEvent("world-atmosphere:phase", {
            detail: {
              phase,
              prevPhase: prev,
              intensity: s5.light,
              isNight,
              lightsOn,
              wash: { top: s5.top, bottom: s5.bottom },
              hour
            }
          })
        );
      }
      this.requestUpdate();
    }
    render() {
      const dark = Math.max(0, 1 - this._light);
      const vig = 0.18 + dark * 0.62;
      const warm = this._phase === "dawn" || this._phase === "dusk" ? 0.5 : 0;
      return b3`
      <div
        class="layer wash"
        style="background:linear-gradient(180deg, ${this._top} 0%, ${this._bottom} 100%); opacity:${0.55 + dark * 0.35}"
      ></div>
      <div
        class="layer darken"
        style="background:${this._bottom}; opacity:${dark * 0.7}"
      ></div>
      <div
        class="layer horizon"
        style="background:radial-gradient(120% 60% at 50% 92%, ${this._bottom} 0%, transparent 60%); opacity:${warm}"
      ></div>
      <div
        class="layer vignette"
        style="--vig:${vig}; background:radial-gradient(125% 125% at 50% 42%, transparent 52%, rgba(2,4,12,0.9) 100%); opacity:${vig}"
      ></div>
    `;
    }
  };
  WorldAtmosphere.styles = i`
    :host {
      position: absolute;
      inset: 0;
      display: block;
      pointer-events: none;
      overflow: hidden;
      contain: strict;
    }
    .layer {
      position: absolute;
      inset: 0;
    }
    /* Colour wash — soft-light keeps the underlying scene legible while tinting. */
    .wash {
      mix-blend-mode: soft-light;
      transition: background 4s ease, opacity 4s ease;
    }
    /* Darkening — multiply the deep horizon colour in as the sun drops. */
    .darken {
      mix-blend-mode: multiply;
      transition: background 4s ease, opacity 4s ease;
    }
    /* Edge vignette that tightens at night. */
    .vignette {
      transition: opacity 4s ease;
      animation: breathe 9s ease-in-out infinite;
    }
    /* Warm pinpoint that rises at dusk/dawn near the horizon. */
    .horizon {
      mix-blend-mode: screen;
      transition: opacity 4s ease, background 4s ease;
    }
    @keyframes breathe {
      0%, 100% { opacity: var(--vig, 0); }
      50% { opacity: calc(var(--vig, 0) * 0.82); }
    }
    :host([data-reduced]) .wash,
    :host([data-reduced]) .darken,
    :host([data-reduced]) .vignette,
    :host([data-reduced]) .horizon {
      transition: none;
      animation: none;
    }
  `;
  __decorateClass([
    n5({ type: String })
  ], WorldAtmosphere.prototype, "override", 2);
  __decorateClass([
    r6()
  ], WorldAtmosphere.prototype, "_top", 2);
  __decorateClass([
    r6()
  ], WorldAtmosphere.prototype, "_bottom", 2);
  __decorateClass([
    r6()
  ], WorldAtmosphere.prototype, "_light", 2);
  __decorateClass([
    r6()
  ], WorldAtmosphere.prototype, "_phase", 2);
  WorldAtmosphere = __decorateClass([
    t4("world-atmosphere")
  ], WorldAtmosphere);

  // src/ui/views/agent-ops/iso/sectors/sector-buildings.ts
  var DEFAULT_PALETTE = {
    line: "#7da2c8",
    gold: "#fbbf24",
    glass: "rgba(125,162,200,0.10)"
  };
  var pad = (hw, line, glass) => w2`<path d="M ${-hw} 0 L 0 ${hw * 0.5} L ${hw} 0 L 0 ${-hw * 0.5} Z"
        fill="${glass}" stroke="${line}" stroke-width="1.5" opacity="0.9"/>`;
  var win = (x3, y4, w3, h4, gold) => w2`<rect class="sector-window" x="${x3}" y="${y4}" width="${w3}" height="${h4}"
        rx="0.8" fill="${gold}" stroke="none" opacity="0.0"/>`;
  function dataVault(p4) {
    const stripes = [-18, -34, -50, -66];
    return w2`
    ${pad(40, p4.line, p4.glass)}
    <g fill="none" stroke="${p4.line}" stroke-width="1.6">
      <!-- cylinder body: two verticals + elliptical caps -->
      <path d="M -28 -6 L -28 -74" />
      <path d="M 28 -6 L 28 -74" />
      <ellipse cx="0" cy="-74" rx="28" ry="11" />
      <path d="M -28 -6 A 28 11 0 0 0 28 -6" />
      ${stripes.map(
      (y4) => w2`<path d="M -28 ${y4} A 28 11 0 0 0 28 ${y4}" opacity="0.55"/>`
    )}
    </g>
    <!-- glowing core slit -->
    <rect class="sector-window" x="-3" y="-70" width="6" height="58" rx="3"
      fill="${p4.gold}" opacity="0" />
    <ellipse cx="0" cy="-74" rx="28" ry="11" fill="none" stroke="${p4.gold}" stroke-width="1.4" opacity="0.85"/>
  `;
  }
  function commsTower(p4) {
    return w2`
    ${pad(30, p4.line, p4.glass)}
    <g fill="none" stroke="${p4.line}" stroke-width="1.5">
      <path d="M -14 -2 L -8 -96 L 8 -96 L 14 -2 Z" />
      <path d="M -12 -28 L 12 -28 M -10 -54 L 10 -54 M -9 -76 L 9 -76" opacity="0.5"/>
      <path d="M -8 -96 L 8 -96 M 0 -96 L 0 -116" />
      <!-- dish -->
      <path d="M 8 -82 q 22 -6 26 -22" stroke-width="1.3"/>
    </g>
    <!-- antenna beacon (pulses via .sector-beacon) -->
    <circle class="sector-beacon sector-window" cx="0" cy="-118" r="3.4" fill="${p4.gold}" opacity="0"/>
    <circle cx="0" cy="-118" r="6.5" fill="none" stroke="${p4.gold}" stroke-width="1.1" opacity="0.7"/>
    ${win(-4, -90, 8, 5, p4.gold)}
  `;
  }
  function bulletinPlaza(p4) {
    const cols = [-44, -22, 0, 22, 44];
    return w2`
    ${pad(58, p4.line, p4.glass)}
    <g fill="none" stroke="${p4.line}" stroke-width="1.5">
      <!-- wide low roof slab -->
      <path d="M -56 -30 L 0 -42 L 56 -30 L 0 -18 Z" />
      <path d="M -56 -30 L -56 -8 L 0 4 L 0 -18 Z" opacity="0.85"/>
      <path d="M 56 -30 L 56 -8 L 0 4 L 0 -18 Z" opacity="0.85"/>
      <!-- bulletin board face -->
      <path d="M -34 -22 L 0 -29 L 0 -10 L -34 -3 Z" opacity="0.6"/>
    </g>
    <!-- column lights along the colonnade -->
    ${cols.map((x3, i6) => win(x3 - 1.4, -30 + Math.abs(x3) * 0.14, 3, 22, p4.gold))}
    <!-- pinned cards -->
    ${[0, 1, 2].map((i6) => win(-30 + i6 * 9, -25 + i6 * 2, 6, 5, p4.gold))}
  `;
  }
  function waveAmphitheater(p4) {
    const arcs = [16, 28, 40, 52];
    return w2`
    ${pad(54, p4.line, p4.glass)}
    <g fill="none" stroke="${p4.line}" stroke-width="1.5">
      ${arcs.map(
      (r7) => w2`<path d="M ${-r7} -6 A ${r7} ${r7 * 0.5} 0 0 1 ${r7} -6" opacity="${0.4 + (52 - r7) / 120}"/>`
    )}
      <!-- stage -->
      <ellipse cx="0" cy="-6" rx="12" ry="6" />
    </g>
    <!-- radiating sound waves from the stage (lit) -->
    <g class="sector-window" opacity="0">
      ${[20, 34, 48].map(
      (r7) => w2`<path d="M ${-r7} -10 A ${r7} ${r7 * 0.5} 0 0 1 ${r7} -10"
            fill="none" stroke="${p4.gold}" stroke-width="1.3"/>`
    )}
    </g>
    <circle cx="0" cy="-8" r="3" fill="${p4.gold}" opacity="0.85"/>
  `;
  }
  function orbitalRing(p4) {
    return w2`
    ${pad(46, p4.line, p4.glass)}
    <g fill="none" stroke="${p4.line}" stroke-width="1.6">
      <!-- core pylon -->
      <path d="M -8 -4 L -5 -60 L 5 -60 L 8 -4 Z" />
      <!-- tilted orbital ring -->
      <ellipse cx="0" cy="-64" rx="42" ry="16" transform="rotate(-18 0 -64)" />
      <ellipse cx="0" cy="-64" rx="30" ry="10" transform="rotate(-18 0 -64)" opacity="0.6"/>
    </g>
    <!-- orbiting satellite node (lit) -->
    <circle class="sector-window" cx="38" cy="-58" r="3.6" fill="${p4.gold}" opacity="0"/>
    <circle class="sector-window" cx="-34" cy="-72" r="2.6" fill="${p4.gold}" opacity="0"/>
    <circle cx="0" cy="-62" r="4" fill="none" stroke="${p4.gold}" stroke-width="1.3" opacity="0.85"/>
  `;
  }
  function centralHub(p4) {
    return w2`
    ${pad(60, p4.line, p4.glass)}
    <g fill="none" stroke="${p4.line}" stroke-width="1.7">
      <!-- ringed plaza base -->
      <ellipse cx="0" cy="-2" rx="52" ry="22" opacity="0.45"/>
      <!-- stepped tiers -->
      <path d="M -40 -10 L 0 -24 L 40 -10 L 0 4 Z" />
      <path d="M -30 -26 L 0 -38 L 30 -26 L 0 -14 Z" />
      <path d="M -18 -44 L 0 -52 L 18 -44 L 0 -36 Z" />
      <!-- crown spire -->
      <path d="M 0 -52 L 0 -88" />
      <path d="M -8 -64 L 0 -88 L 8 -64" />
    </g>
    <!-- crown beacon + tier windows -->
    <circle class="sector-window sector-beacon" cx="0" cy="-90" r="3.6" fill="${p4.gold}" opacity="0"/>
    ${[-24, -8, 8, 24].map((x3) => win(x3 - 1.4, -30 + Math.abs(x3) * 0.2, 3, 9, p4.gold))}
    <path d="M -40 -10 L 0 -24 L 40 -10" fill="none" stroke="${p4.gold}" stroke-width="1.2" opacity="0.8"/>
  `;
  }
  function observatoryDome(p4) {
    return w2`
    ${pad(40, p4.line, p4.glass)}
    <g fill="none" stroke="${p4.line}" stroke-width="1.6">
      <!-- drum -->
      <path d="M -26 -6 L -26 -38" />
      <path d="M 26 -6 L 26 -38" />
      <path d="M -26 -6 A 26 10 0 0 0 26 -6" />
      <!-- dome -->
      <path d="M -26 -38 A 26 26 0 0 1 26 -38" />
      <path d="M -26 -38 A 26 8 0 0 0 26 -38" opacity="0.5"/>
      <!-- sky slit + telescope -->
      <path d="M -4 -62 L 22 -78" stroke-width="1.4"/>
    </g>
    <rect class="sector-window" x="-3" y="-62" width="6" height="22" rx="3" fill="${p4.gold}" opacity="0"/>
    ${[-18, 0, 18].map((x3) => win(x3 - 1.2, -20, 2.4, 8, p4.gold))}
  `;
  }
  function residentialPods(p4) {
    const pods = [
      [-26, -2, 18],
      [10, 2, 22],
      [30, -8, 14],
      [-4, -14, 16]
    ];
    return w2`
    ${pad(48, p4.line, p4.glass)}
    <g fill="none" stroke="${p4.line}" stroke-width="1.5">
      ${pods.map(
      ([x3, y4, r7]) => w2`
        <path d="M ${x3 - r7} ${y4} A ${r7} ${r7} 0 0 1 ${x3 + r7} ${y4} Z" />
        <path d="M ${x3 - r7} ${y4} A ${r7} ${r7 * 0.35} 0 0 0 ${x3 + r7} ${y4}" opacity="0.5"/>`
    )}
    </g>
    <!-- porthole lights -->
    ${pods.map(([x3, y4, r7]) => win(x3 - 2.5, y4 - r7 * 0.6, 5, 5, p4.gold))}
  `;
  }
  function reactorBay(p4) {
    return w2`
    ${pad(46, p4.line, p4.glass)}
    <g fill="none" stroke="${p4.line}" stroke-width="1.6">
      <!-- hall box -->
      <path d="M -40 -8 L -40 -40 L 0 -54 L 0 -22 Z" />
      <path d="M 40 -8 L 40 -40 L 0 -54 L 0 -22 Z" />
      <path d="M -40 -40 L 0 -54 L 40 -40 L 0 -26 Z" />
      <!-- exhaust stacks -->
      <path d="M 18 -47 L 18 -66 M 26 -49 L 26 -62" />
    </g>
    <!-- reactor core slit (pulsing) -->
    <rect class="sector-window sector-beacon" x="-3" y="-44" width="6" height="20" rx="2" fill="${p4.gold}" opacity="0"/>
    <!-- vent louvres -->
    ${[-30, -22, -14].map((x3, i6) => win(x3, -30 - i6 * 4, 5, 2.4, p4.gold))}
    ${[14, 22, 30].map((x3, i6) => win(x3, -30 - (2 - i6) * 4, 5, 2.4, p4.gold))}
  `;
  }
  function forgeWorkshop(p4) {
    return w2`
    ${pad(44, p4.line, p4.glass)}
    <g fill="none" stroke="${p4.line}" stroke-width="1.6">
      <!-- gabled body -->
      <path d="M -36 -6 L -36 -30 L 0 -34 L 0 -10 Z" />
      <path d="M 36 -6 L 36 -30 L 0 -34 L 0 -10 Z" />
      <!-- pitched roof -->
      <path d="M -36 -30 L 0 -50 L 36 -30 L 0 -34 Z" />
      <!-- chimney -->
      <path d="M 18 -42 L 18 -60 L 26 -62 L 26 -45" />
    </g>
    <!-- forge mouth (warm, lit) + sparks -->
    <path class="sector-window" d="M -22 -10 L -8 -12 L -8 -22 L -22 -20 Z" fill="${p4.gold}" opacity="0"/>
    ${win(24, -64, 3, 4, p4.gold)}
    ${[6, 16].map((x3, i6) => win(x3 - 14, -22 - i6 * 5, 2, 2, p4.gold))}
  `;
  }
  var BUILDINGS = [
    { sectorId: "the-vault", label: "DATA VAULT", archetype: "data-vault", draw: dataVault },
    { sectorId: "comms-deck", label: "COMMS TOWER", archetype: "comms-tower", draw: commsTower },
    { sectorId: "mission-control", label: "BULLETIN PLAZA", archetype: "bulletin-plaza", draw: bulletinPlaza },
    { sectorId: "broadcast-studio", label: "WAVE AMPHITHEATER", archetype: "amphitheater", draw: waveAmphitheater },
    { sectorId: "command-atrium", label: "ORBITAL RING", archetype: "orbital-ring", draw: orbitalRing },
    { sectorId: "gateway-concourse", label: "GATEWAY HUB", archetype: "central-hub", draw: centralHub },
    { sectorId: "observatory", label: "OBSERVATORY", archetype: "observatory-dome", draw: observatoryDome },
    { sectorId: "agent-quarters", label: "AGENT QUARTERS", archetype: "residential-pods", draw: residentialPods },
    { sectorId: "engineering-bay", label: "REACTOR BAY", archetype: "reactor-bay", draw: reactorBay },
    { sectorId: "canvas-atrium", label: "FORGE WORKSHOP", archetype: "forge-workshop", draw: forgeWorkshop }
  ];

  // src/ui/views/agent-ops/iso/sectors/world-sectors.ts
  var STATION = { cols: 24, rows: 24 };
  var SECTOR_CENTERS = {
    observatory: { c: 4, r: 4 },
    "mission-control": { c: 12, r: 4 },
    "comms-deck": { c: 20, r: 4 },
    "agent-quarters": { c: 4, r: 12 },
    "command-atrium": { c: 12, r: 12 },
    "broadcast-studio": { c: 20, r: 10 },
    "the-vault": { c: 20, r: 14 },
    "engineering-bay": { c: 4, r: 20 },
    "gateway-concourse": { c: 12, r: 20 },
    "canvas-atrium": { c: 20, r: 20 }
  };
  var TILE_W = 40;
  var TILE_H = 20;
  var VIEW_W = 1100;
  var VIEW_H = 640;
  var ORIGIN_X = VIEW_W / 2;
  var ORIGIN_Y = 70;
  function isoOf(c5, r7) {
    const cc = c5 - STATION.cols / 2;
    const rr = r7 - STATION.rows / 2;
    return {
      x: ORIGIN_X + (cc - rr) * (TILE_W / 2),
      y: ORIGIN_Y + (cc + rr) * (TILE_H / 2) + VIEW_H * 0.33,
      depth: cc + rr
      // painter's order: smaller = farther/back
    };
  }
  var WorldSectors = class extends i5 {
    constructor() {
      super(...arguments);
      this.labels = false;
      this.lit = false;
      this._lit = false;
      this._override = null;
      this._palette = DEFAULT_PALETTE;
      this._cam = { panX: 0, panY: 0, zoom: 1 };
      this._onPhase = (e6) => {
        const d4 = e6.detail || {};
        if (this._override == null) this._lit = !!d4.lightsOn;
      };
    }
    connectedCallback() {
      super.connectedCallback();
      window.addEventListener("world-atmosphere:phase", this._onPhase);
      if (this._override == null) {
        const ds = document.documentElement.dataset.worldLights;
        if (ds) this._lit = ds === "on";
        else if (typeof window.__worldLightsOn === "boolean")
          this._lit = window.__worldLightsOn;
      }
      this._reflectLit();
    }
    disconnectedCallback() {
      super.disconnectedCallback();
      window.removeEventListener("world-atmosphere:phase", this._onPhase);
    }
    updated() {
      this._reflectLit();
    }
    /** Force lights on/off, or null to resume following <world-atmosphere>. */
    setLit(v3) {
      this._override = v3;
      if (v3 != null) this._lit = v3;
      this.requestUpdate();
    }
    /** Nudge the layout to roughly track the host camera. */
    setCamera(cam) {
      this._cam = { ...this._cam, ...cam };
      this.requestUpdate();
    }
    _reflectLit() {
      const on = this._override ?? this._lit ?? this.lit;
      if (on) this.setAttribute("data-lit", "");
      else this.removeAttribute("data-lit");
    }
    render() {
      const p4 = this._palette;
      const placed = BUILDINGS.map((b4) => {
        const c5 = SECTOR_CENTERS[b4.sectorId] ?? { c: 12, r: 12 };
        return { b: b4, iso: isoOf(c5.c, c5.r) };
      }).sort((a4, z3) => a4.iso.depth - z3.iso.depth);
      const { panX, panY, zoom } = this._cam;
      return b3`
      <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <g transform="translate(${panX} ${panY}) scale(${zoom})">
          ${placed.map(
        ({ b: b4, iso }) => w2`
              <g class="building" transform="translate(${iso.x} ${iso.y})">
                <title>${b4.label} · ${b4.archetype}</title>
                <!-- glassmorphic ground halo -->
                <ellipse class="glass-base" cx="0" cy="0" rx="46" ry="20"
                  fill="${p4.gold}" />
                ${b4.draw(p4)}
                ${this.labels ? w2`<text class="label" x="0" y="24">${b4.label}</text>` : ""}
              </g>`
      )}
        </g>
      </svg>
    `;
    }
  };
  WorldSectors.styles = i`
    :host {
      position: absolute;
      inset: 0;
      display: block;
      pointer-events: none;
      overflow: hidden;
    }
    svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .building {
      transition: filter 2.5s ease;
    }
    .label {
      font: 600 9px/1 ui-monospace, monospace;
      fill: rgba(213, 226, 245, 0.55);
      letter-spacing: 0.12em;
      text-anchor: middle;
    }
    /* Windows / lamps — dark by day, gold glow once lit. */
    .sector-window {
      transition: opacity 2.8s ease;
    }
    :host([data-lit]) .sector-window {
      opacity: 0.95 !important;
      filter: drop-shadow(0 0 4px rgba(251, 191, 36, 0.95))
        drop-shadow(0 0 9px rgba(251, 191, 36, 0.5));
    }
    /* Structural lines warm + brighten once the city is lit. */
    .building {
      stroke-opacity: 0.9;
    }
    :host([data-lit]) .building {
      filter: drop-shadow(0 0 6px rgba(251, 191, 36, 0.4));
    }
    /* Glassmorphic night halo behind each volume. */
    :host([data-lit]) .glass-base {
      opacity: 0.5;
    }
    .glass-base {
      opacity: 0.12;
      transition: opacity 2.5s ease;
    }
    /* Beacons pulse only when lit (reduced-motion disables it). */
    :host([data-lit]) .sector-beacon {
      animation: pulse 2.4s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .building,
      .sector-window,
      .glass-base {
        transition: none;
      }
      :host([data-lit]) .sector-beacon {
        animation: none;
        opacity: 0.9;
      }
    }
  `;
  __decorateClass([
    n5({ type: Boolean })
  ], WorldSectors.prototype, "labels", 2);
  __decorateClass([
    n5({ type: Boolean })
  ], WorldSectors.prototype, "lit", 2);
  __decorateClass([
    r6()
  ], WorldSectors.prototype, "_lit", 2);
  WorldSectors = __decorateClass([
    t4("world-sectors")
  ], WorldSectors);

  // src/ui/views/agent-ops/iso/sectors/__test.entry.ts
  var stage = document.getElementById("stage");
  stage.innerHTML = `
  <div style="position:absolute;inset:0;background:radial-gradient(120% 120% at 50% 30%, #16203a 0%, #070a14 70%)"></div>
  <world-atmosphere style="position:absolute;inset:0;z-index:1"></world-atmosphere>
  <world-sectors labels style="position:absolute;inset:0;z-index:2"></world-sectors>
  <div id="badge" style="position:absolute;left:12px;top:10px;z-index:9;font:700 14px ui-monospace,monospace;color:#fbbf24;letter-spacing:.15em;text-shadow:0 1px 4px #000"></div>
`;
  var atmo = stage.querySelector("world-atmosphere");
  var badge = stage.querySelector("#badge");
  window.__setPhase = (p4) => {
    atmo.setTimeOverride(p4);
    badge.textContent = p4.toUpperCase();
  };
  window.__setPhase("day");
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
