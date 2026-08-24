"use client";
import { FormEvent, useEffect, useState } from "react";
type ListingImage = { url: string; width?: number; height?: number };
type Product = {
  id: number;
  title: string;
  description?: string;
  priceCents: number;
  originalPriceCents?: number | null;
  quantity?: number;
  shippingMode?: string;
  shippingFeeCents?: number;
  selfPickup?: boolean;
  categoryMode?: string;
  categoryId?: string;
  categoryName?: string;
  skuJson?: string;
  propertiesJson?: string;
  status: string;
  xianyuItemId?: string;
  deliveryType?: string;
  deliveryContent?: string;
  imagesJson?: string;
  lastError?: string;
};
type Summary = {
  products: number;
  queued: number;
  published: number;
  inventory: number;
  delivered: number;
};
type Run = {
  id: number;
  job: string;
  status: string;
  summary: string;
  startedAt: string;
  finishedAt?: string;
};
type Rule = Product & { available: number; reserved: number; used: number };
type InventoryRow = {
  id: number;
  secret: string;
  status: "available" | "reserved" | "used";
  orderId?: string;
};
type Account = {
  valid: boolean;
  nick?: string;
  error?: string;
  autoRenewal?: boolean;
  tokenExpiresAt?: string | null;
  tokenRefreshedAt?: string | null;
  email?: { configured: boolean; recipient: string; sender: string };
};
const nav = ["总览", "商品上架", "自动发货", "任务记录", "系统设置"];
export default function Home() {
  const [active, setActive] = useState("总览"),
    [products, setProducts] = useState<Product[]>([]),
    [summary, setSummary] = useState<Summary>({
      products: 0,
      queued: 0,
      published: 0,
      inventory: 0,
      delivered: 0,
    }),
    [runs, setRuns] = useState<Run[]>([]),
    [loading, setLoading] = useState(true),
    [notice, setNotice] = useState(""),
    [syncing, setSyncing] = useState(false),
    [account, setAccount] = useState<Account | null>(null);
  async function json(url: string, init?: RequestInit) {
    const r = await fetch(url, { cache: "no-store", ...init }),
      d = await r.json();
    if (!r.ok) throw new Error(d.error || "操作失败");
    return d;
  }
  async function refresh() {
    setLoading(true);
    try {
      const d = await json("/api/dashboard");
      setProducts(d.products);
      setSummary(d.summary);
    } catch (e) {
      setNotice(message(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (active === "任务记录")
      json("/api/jobs")
        .then((d) => setRuns(d.runs))
        .catch((e) => setNotice(message(e)));
    if (active === "系统设置") checkAccount();
  }, [active]);
  async function checkAccount() {
    setAccount(null);
    try {
      const response = await fetch("/api/xianyu/status", { cache: "no-store" });
      const data = await response.json();
      setAccount(data);
    } catch (e) {
      setAccount({ valid: false, error: message(e), autoRenewal: true });
    }
  }
  async function syncItems() {
    setSyncing(true);
    try {
      const d = await json("/api/xianyu/items", { method: "POST" });
      const detail = `获取 ${d.synced} 件，在售 ${d.published || 0} 件，已下架 ${(d.offline || 0) + (d.markedOffline || 0)} 件，已售出 ${d.sold || 0} 件`;
      setNotice(
        d.warning ? `同步完成：${detail}；${d.warning}` : `同步完成：${detail}`,
      );
      await refresh();
    } catch (e) {
      setNotice(message(e));
    } finally {
      setSyncing(false);
    }
  }
  async function listingPayload(form: HTMLFormElement) {
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries()) as Record<
      string,
      unknown
    >;
    const images: ListingImage[] = String(formData.get("images") || "")
      .split(/[\n,]+/)
      .map((url) => ({ url: url.trim() }))
      .filter((image) => image.url);
    const files = formData
      .getAll("imageFiles")
      .filter(
        (entry): entry is File => entry instanceof File && entry.size > 0,
      );
    if (files.length) setNotice(`正在上传 ${files.length} 张商品图片…`);
    for (const file of files) {
      const upload = new FormData();
      upload.append("file", file);
      const result = await json("/api/xianyu/upload", {
        method: "POST",
        body: upload,
      });
      images.push(result.image);
    }
    delete payload.imageFiles;
    payload.images = images;
    payload.selfPickup = formData.has("selfPickup");
    return payload;
  }
  async function addProduct(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      const payload = await listingPayload(form);
      await json("/api/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      setNotice("商品已加入发布队列");
      form.reset();
      await refresh();
    } catch (e) {
      setNotice(message(e));
    }
  }
  async function editProduct(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      const payload = await listingPayload(form);
      payload.action = "edit_listing";
      await json("/api/products", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      setNotice("商品信息已保存并同步到闲鱼");
      await refresh();
      return true;
    } catch (e) {
      setNotice(message(e));
      return false;
    }
  }
  async function takeOffline(product: Product) {
    if (!window.confirm(`确认下架“${product.title}”吗？`)) return false;
    try {
      await json("/api/products", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: product.id }),
      });
      setNotice("商品已下架");
      await refresh();
      return true;
    } catch (e) {
      setNotice(message(e));
      return false;
    }
  }
  async function publishProduct(product: Product) {
    if (!window.confirm(`确认立即上架“${product.title}”吗？`)) return false;
    try {
      await json("/api/products", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: product.id, action: "publish_listing" }),
      });
      setNotice("商品已上架");
      await refresh();
      return true;
    } catch (e) {
      setNotice(message(e));
      return false;
    }
  }
  async function loadProduct(product: Product) {
    if (!product.xianyuItemId) return product;
    try {
      const result = await json(
        `/api/xianyu/item?id=${encodeURIComponent(product.xianyuItemId)}`,
      );
      return {
        ...product,
        title: result.item.title || product.title,
        description: result.item.description || product.description,
        priceCents: result.item.priceCents || product.priceCents,
        originalPriceCents: result.item.originalPriceCents,
        quantity: result.item.quantity || product.quantity || 1,
        shippingMode: result.item.shippingMode || product.shippingMode,
        shippingFeeCents:
          result.item.shippingFeeCents ?? product.shippingFeeCents,
        selfPickup: result.item.selfPickup ?? product.selfPickup,
        categoryMode: result.item.categoryMode || product.categoryMode,
        categoryId: result.item.categoryId || product.categoryId,
        categoryName: result.item.categoryName || product.categoryName,
        skuJson: JSON.stringify(result.item.skus || []),
        propertiesJson: JSON.stringify(result.item.properties || []),
        imagesJson: result.item.images?.length
          ? JSON.stringify(result.item.images)
          : product.imagesJson,
      } as Product;
    } catch (e) {
      setNotice(message(e));
      return product;
    }
  }
  async function saveDelivery(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      p = Object.fromEntries(new FormData(form).entries());
    try {
      await json("/api/products", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(p),
      });
      if (p.deliveryType === "inventory" && String(p.secrets || "").trim())
        await json("/api/inventory", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ productId: Number(p.id), secrets: p.secrets }),
        });
      setNotice("自动发货规则已保存");
      form.reset();
      await refresh();
    } catch (e) {
      setNotice(message(e));
    }
  }
  async function runNow() {
    try {
      const d = await json("/api/jobs/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      setNotice(
        `任务完成：扫描 ${d.pendingOrders || 0} 单，发布 ${d.published || 0} 件，自动发货 ${d.delivered || 0} 单，待补配置 ${d.configurationAlerts || 0} 单，邮件 ${d.emailsSent || 0} 封`,
      );
      await refresh();
    } catch (e) {
      setNotice(message(e));
    }
  }
  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="fish">鱼</span>
          <div>
            <b>闲鱼自动运营</b>
            <small>Auto Ops</small>
          </div>
        </div>
        <nav>
          {nav.map((x) => (
            <button
              key={x}
              className={active === x ? "active" : ""}
              onClick={() => setActive(x)}
            >
              <span>
                {x === "总览"
                  ? "◫"
                  : x === "商品上架"
                    ? "＋"
                    : x === "自动发货"
                      ? "↗"
                      : x === "任务记录"
                        ? "≡"
                        : "⚙"}
              </span>
              {x}
            </button>
          ))}
        </nav>
        <div className="side-status">
          <i />
          <div>
            <b>自动任务正常</b>
            <small>等待 Cron 定时触发</small>
          </div>
        </div>
      </aside>
      <section className="content">
        <header>
          <div>
            <h1>{active}</h1>
            <p>{subtitle(active)}</p>
          </div>
          <div className="actions">
            {active === "商品上架" && (
              <button
                className="ghost sync"
                onClick={syncItems}
                disabled={syncing}
              >
                {syncing ? "正在同步…" : "↻ 同步闲鱼商品"}
              </button>
            )}
            <button className="run" onClick={runNow}>
              ▶ 立即执行
            </button>
          </div>
        </header>
        {notice && (
          <div className="notice" onClick={() => setNotice("")}>
            {notice}
            <span>×</span>
          </div>
        )}
        {active === "总览" && (
          <Overview
            summary={summary}
            products={products}
            loading={loading}
            refresh={refresh}
          />
        )}{" "}
        {active === "商品上架" && (
          <Listings
            products={products}
            addProduct={addProduct}
            editProduct={editProduct}
            takeOffline={takeOffline}
            publishProduct={publishProduct}
            loadProduct={loadProduct}
            syncItems={syncItems}
            syncing={syncing}
          />
        )}{" "}
        {active === "自动发货" && (
          <Delivery save={saveDelivery} notify={setNotice} />
        )}{" "}
        {active === "任务记录" && <Jobs runs={runs} />}{" "}
        {active === "系统设置" && (
          <Settings account={account} refresh={checkAccount} />
        )}
      </section>
    </main>
  );
}
function Overview({
  summary,
  products,
  loading,
  refresh,
}: {
  summary: Summary;
  products: Product[];
  loading: boolean;
  refresh: () => void;
}) {
  return (
    <>
      <div className="stats">
        <Stat
          label="商品总数"
          value={summary.products}
          hint={`${summary.queued} 个等待发布`}
          tone="blue"
        />
        <Stat
          label="已发布"
          value={summary.published}
          hint="闲鱼在售商品"
          tone="cyan"
        />
        <Stat
          label="可用库存"
          value={summary.inventory}
          hint="卡密 / 发货内容"
          tone="violet"
        />
        <Stat
          label="已自动发货"
          value={summary.delivered}
          hint="去重保护已开启"
          tone="green"
        />
      </div>
      <ProductPanel
        title="最近商品"
        sub={loading ? "正在同步…" : "包含闲鱼同步商品和待发布任务"}
        products={products.slice(0, 12)}
        action={
          <button className="ghost" onClick={refresh}>
            刷新
          </button>
        }
      />
      <section className="panel cron">
        <div>
          <span className="pulse" />
          <div>
            <h2>定时任务接口已就绪</h2>
            <p>每 5 分钟自动检查发布队列和待发货订单。</p>
          </div>
        </div>
        <code>POST /api/jobs/run</code>
      </section>
    </>
  );
}
function Listings({
  products,
  addProduct,
  editProduct,
  takeOffline,
  publishProduct,
  loadProduct,
  syncItems,
  syncing,
}: {
  products: Product[];
  addProduct: (e: FormEvent<HTMLFormElement>) => void;
  editProduct: (e: FormEvent<HTMLFormElement>) => Promise<boolean>;
  takeOffline: (product: Product) => Promise<boolean>;
  publishProduct: (product: Product) => Promise<boolean>;
  loadProduct: (product: Product) => Promise<Product>;
  syncItems: () => void;
  syncing: boolean;
}) {
  const [q, setQ] = useState(""),
    [status, setStatus] = useState("all"),
    [source, setSource] = useState("all"),
    [editing, setEditing] = useState<Product | null>(null);
  const filtered = products.filter(
    (p) =>
      (!q ||
        `${p.title} ${p.xianyuItemId || ""}`
          .toLowerCase()
          .includes(q.toLowerCase())) &&
      (status === "all" || p.status === status) &&
      (source === "all" ||
        (source === "synced" ? Boolean(p.xianyuItemId) : !p.xianyuItemId)),
  );
  async function submitEdit(e: FormEvent<HTMLFormElement>) {
    if (await editProduct(e)) setEditing(null);
  }
  return (
    <>
      <section className="filter-bar panel">
        <div className="search-box">
          ⌕
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索商品标题或闲鱼商品编号"
          />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">全部状态</option>
          <option value="published">在售</option>
          <option value="offline">已下架</option>
          <option value="sold">已售出</option>
          <option value="unknown">其他状态</option>
          <option value="draft">草稿</option>
          <option value="queued">待发布</option>
          <option value="failed">发布失败</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="all">全部来源</option>
          <option value="synced">闲鱼已同步</option>
          <option value="local">本地上架任务</option>
        </select>
        <b>
          {filtered.length} / {products.length} 件
        </b>
      </section>
      <div className="workspace-grid">
        <section className="panel form-panel">
          <div className="panel-title">
            <div>
              <h2>{editing ? "修改商品信息" : "新建上架任务"}</h2>
              <p>
                {editing
                  ? "保存后同步修改标题、价格、描述和图片"
                  : "创建新商品并加入限速发布队列"}
              </p>
            </div>
            {editing ? (
              <button className="ghost" onClick={() => setEditing(null)}>
                取消修改
              </button>
            ) : (
              <span className="tag">每分钟最多 1 件</span>
            )}
          </div>
          <form
            key={editing?.id || "new"}
            onSubmit={editing ? submitEdit : addProduct}
          >
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <label>
              商品标题
              <input
                name="title"
                required
                maxLength={60}
                defaultValue={editing?.title || ""}
              />
            </label>
            <div className="form-row">
              <label>
                售价（元）
                <input
                  name="price"
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  defaultValue={
                    editing ? (editing.priceCents / 100).toFixed(2) : ""
                  }
                />
              </label>
              <label>
                原价（元，可选）
                <input
                  name="originalPrice"
                  type="number"
                  min="0.01"
                  step="0.01"
                  defaultValue={
                    editing?.originalPriceCents
                      ? (editing.originalPriceCents / 100).toFixed(2)
                      : ""
                  }
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                商品库存
                <input
                  name="quantity"
                  type="number"
                  required
                  min="1"
                  max="9999"
                  step="1"
                  defaultValue={editing?.quantity || 1}
                />
              </label>
              <label>
                运费计价方式
                <select
                  name="shippingMode"
                  defaultValue={editing?.shippingMode || "none"}
                >
                  <option value="none">不支持邮寄（虚拟交付）</option>
                  <option value="free">包邮</option>
                  <option value="distance">按距离计价</option>
                  <option value="fixed">固定邮费</option>
                </select>
              </label>
            </div>
            <div className="form-row">
              <label>
                固定邮费（元）
                <input
                  name="shippingFee"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={
                    editing?.shippingFeeCents
                      ? (editing.shippingFeeCents / 100).toFixed(2)
                      : "0.00"
                  }
                />
              </label>
              <label className="inline-check">
                <input
                  name="selfPickup"
                  type="checkbox"
                  defaultChecked={editing?.selfPickup || false}
                />
                支持当面自提
              </label>
            </div>
            <div className="form-row">
              <label>
                类目设置
                <select
                  name="categoryMode"
                  defaultValue={editing?.categoryMode || "auto"}
                >
                  <option value="auto">自动推荐类目</option>
                  <option value="manual">手动指定类目</option>
                </select>
              </label>
              <label>
                闲鱼类目 ID（手动时必填）
                <input
                  name="categoryId"
                  defaultValue={editing?.categoryId || ""}
                  placeholder="例如 50025358"
                />
              </label>
            </div>
            <label>
              类目名称（可选）
              <input
                name="categoryName"
                defaultValue={editing?.categoryName || ""}
                placeholder="仅用于记录和提交类目名称"
              />
            </label>
            <label>
              商品描述
              <textarea
                name="description"
                rows={4}
                defaultValue={editing?.description || ""}
              />
            </label>
            <label>
              商品规格（可选）
              <textarea
                name="skuLines"
                rows={4}
                defaultValue={editing ? skuLines(editing) : ""}
                placeholder={"每行：规格=值;规格2=值2|价格元|库存\n示例：颜色=蓝色;容量=128G|99.00|10"}
              />
            </label>
            <label>
              商品属性（可选）
              <textarea
                name="propertyLines"
                rows={3}
                defaultValue={editing ? propertyLines(editing) : ""}
                placeholder={"每行：属性=值\n示例：品牌=无品牌"}
              />
            </label>
            <label>
              图片链接
              <textarea
                name="images"
                rows={3}
                defaultValue={editing ? imageUrls(editing).join("\n") : ""}
                placeholder="多个链接用换行或逗号分隔"
              />
            </label>
            <label>
              上传图片（可直接选择本地文件）
              <input
                name="imageFiles"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/heic"
                multiple
              />
            </label>
            <div className="form-row">
              <label>
                自动发货方式
                <select
                  name="deliveryType"
                  defaultValue={editing?.deliveryType || "text"}
                >
                  <option value="text">固定文本 / 链接</option>
                  <option value="inventory">卡密库存</option>
                </select>
              </label>
              <label>
                发货说明 / 固定文本
                <textarea
                  name="deliveryContent"
                  rows={3}
                  defaultValue={editing?.deliveryContent || ""}
                  placeholder="卡密模式可填写发送在卡密前的说明"
                />
              </label>
            </div>
            <button className="primary">
              {editing ? "保存商品修改" : "加入发布队列"}
            </button>
          </form>
        </section>
        <ProductPanel
          title="账号商品"
          sub="同步后可直接维护现有在售商品"
          products={filtered}
          action={
            <button className="ghost" onClick={syncItems}>
              {syncing ? "同步中…" : "同步"}
            </button>
          }
          productAction={(product) => (
            <div className="product-actions">
              <button
                className="ghost"
                onClick={async () => setEditing(await loadProduct(product))}
              >
                修改
              </button>
              {(product.status === "draft" ||
                product.status === "queued" ||
                product.status === "failed") && (
                <button
                  className="ghost"
                  onClick={() => publishProduct(product)}
                >
                  立即上架
                </button>
              )}
              {product.status === "published" && (
                <button
                  className="ghost danger"
                  onClick={() => takeOffline(product)}
                >
                  下架
                </button>
              )}
            </div>
          )}
        />
      </div>
    </>
  );
}
function Delivery({
  save,
  notify,
}: {
  save: (e: FormEvent<HTMLFormElement>) => Promise<void>;
  notify: (s: string) => void;
}) {
  const [rules, setRules] = useState<Rule[]>([]),
    [selected, setSelected] = useState<Rule | null>(null),
    [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]),
    [reload, setReload] = useState(0),
    [q, setQ] = useState(""),
    [configured, setConfigured] = useState("all"),
    [kind, setKind] = useState("all");
  useEffect(() => {
    fetch("/api/delivery-rules", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const next = d.rules || [];
        setRules(next);
        setSelected((current) =>
          current ? next.find((rule: Rule) => rule.id === current.id) || null : null,
        );
      })
      .catch(() => notify("读取发货规则失败"));
  }, [reload, notify]);
  useEffect(() => {
    if (!selected) return;
    fetch(`/api/inventory?productId=${selected.id}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setInventoryRows(d.inventory || []))
      .catch(() => notify("读取卡密明细失败"));
  }, [selected, reload, notify]);
  const isConfigured = (r: Rule) =>
    r.deliveryType === "inventory"
      ? r.available > 0
      : Boolean(r.deliveryContent?.trim());
  const filtered = rules.filter(
    (r) =>
      (!q ||
        `${r.title} ${r.xianyuItemId || ""}`
          .toLowerCase()
          .includes(q.toLowerCase())) &&
      (configured === "all" ||
        (configured === "yes" ? isConfigured(r) : !isConfigured(r))) &&
      (kind === "all" || r.deliveryType === kind),
  );
  async function submit(e: FormEvent<HTMLFormElement>) {
    await save(e);
    setSelected(null);
    setReload((x) => x + 1);
  }
  async function removeInventory(row: InventoryRow) {
    if (!window.confirm("确认删除这条未使用卡密吗？")) return;
    try {
      const response = await fetch("/api/inventory", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: row.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "删除失败");
      notify("卡密已删除");
      setReload((x) => x + 1);
    } catch (error) {
      notify(message(error));
    }
  }
  return (
    <>
      <section className="filter-bar panel">
        <div className="search-box">
          ⌕
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索商品标题或闲鱼商品编号"
          />
        </div>
        <select
          value={configured}
          onChange={(e) => setConfigured(e.target.value)}
        >
          <option value="all">全部配置状态</option>
          <option value="yes">已配置</option>
          <option value="no">未配置</option>
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="all">全部发货类型</option>
          <option value="text">固定文本 / 链接</option>
          <option value="inventory">卡密库存</option>
        </select>
        <b>
          {filtered.length} / {rules.length} 件
        </b>
      </section>
      <div className="delivery-layout">
        <section className="panel rules-panel">
          <div className="panel-title">
            <div>
              <h2>发货规则</h2>
              <p>查看具体内容，选择商品后可直接修改</p>
            </div>
          </div>
          <div className="rule-list">
            {filtered.length ? (
              filtered.map((r) => (
                <article
                  key={r.id}
                  className={selected?.id === r.id ? "selected" : ""}
                >
                  <div className="rule-head">
                    <div>
                      <b>{r.title}</b>
                      <small>{r.xianyuItemId}</small>
                    </div>
                    <button className="ghost" onClick={() => setSelected(r)}>
                      查看 / 修改
                    </button>
                  </div>
                  <div className="rule-detail">
                    <span
                      className={
                        isConfigured(r)
                          ? "configured-chip"
                          : "unconfigured-chip"
                      }
                    >
                      {isConfigured(r) ? "已配置" : "未配置"}
                    </span>
                    <span>
                      方式：
                      {r.deliveryType === "inventory"
                        ? "卡密库存"
                        : "固定文本 / 链接"}
                    </span>
                    {r.deliveryType === "inventory" ? (
                      <span>
                        可用 {r.available} · 已预留 {r.reserved} · 已用 {r.used}
                      </span>
                    ) : (
                      <pre>{r.deliveryContent || "尚未配置发货内容"}</pre>
                    )}
                  </div>
                </article>
              ))
            ) : (
              <div className="empty">
                <b>没有符合条件的商品</b>
                <p>请调整关键词或筛选条件</p>
              </div>
            )}
          </div>
        </section>
        <section className="panel form-panel sticky-form">
          <div className="panel-title">
            <div>
              <h2>{selected ? "修改发货配置" : "新增发货配置"}</h2>
              <p>
                {selected
                  ? "更新后下一笔订单立即使用新内容"
                  : "选择商品并配置交付方式"}
              </p>
            </div>
            {selected && (
              <button className="ghost" onClick={() => setSelected(null)}>
                取消编辑
              </button>
            )}
          </div>
          <form key={selected?.id || "new"} onSubmit={submit}>
            <label>
              选择商品
              <select
                name="id"
                required
                value={selected?.id || ""}
                onChange={(e) =>
                  setSelected(
                    rules.find((r) => r.id === Number(e.target.value)) || null,
                  )
                }
              >
                <option value="" disabled>
                  请选择商品
                </option>
                {rules.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              发货方式
              <select
                name="deliveryType"
                defaultValue={selected?.deliveryType || "text"}
              >
                <option value="text">固定文本 / 网盘链接</option>
                <option value="inventory">卡密库存</option>
              </select>
            </label>
            <label>
              具体发货内容
              <textarea
                name="deliveryContent"
                rows={7}
                defaultValue={selected?.deliveryContent || ""}
                placeholder="付款后发送给买家的完整文字、资料链接和提取码"
              />
            </label>
            <label>
              追加卡密
              <textarea
                name="secrets"
                rows={5}
                placeholder="每行一个；留空不会删除现有库存"
              />
            </label>
            {selected && (
              <section className="inventory-detail">
                <div>
                  <b>已配置卡密明细</b>
                  <small>
                    可用 {selected.available} · 已预留 {selected.reserved} ·
                    已用 {selected.used}
                  </small>
                </div>
                {inventoryRows.length ? (
                  <div className="inventory-list">
                    {inventoryRows.map((row) => (
                      <article key={row.id}>
                        <code>{row.secret}</code>
                        <span>{inventoryStatus(row.status)}</span>
                        {row.status === "available" && (
                          <button
                            type="button"
                            className="ghost danger"
                            onClick={() => removeInventory(row)}
                          >
                            删除
                          </button>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p>尚未导入卡密。</p>
                )}
              </section>
            )}
            <button className="primary">
              {selected ? "保存修改" : "保存发货规则"}
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
function Jobs({ runs }: { runs: Run[] }) {
  return (
    <section className="panel table-panel">
      <div className="panel-title">
        <div>
          <h2>任务执行记录</h2>
          <p>查看 Cron 发布与发货任务结果</p>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>任务</th>
            <th>状态</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {runs.length ? (
            runs.map((r) => (
              <tr key={r.id}>
                <td>{r.startedAt}</td>
                <td>{r.job}</td>
                <td>
                  <Status value={r.status} />
                </td>
                <td>
                  <code>{formatRunSummary(r.summary)}</code>
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={4}>暂无执行记录</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
function Settings({
  account,
  refresh,
}: {
  account: Account | null;
  refresh: () => Promise<void>;
}) {
  return (
    <div className="settings-grid">
      <section className="panel setting-card">
        <span className={account?.valid ? "ok-dot" : "bad-dot"} />
        <div>
          <h2>闲鱼账号</h2>
          <p>
            {!account
              ? "正在检测并自动续期…"
              : account.valid
                ? `Cookie 有效${account.nick ? ` · ${account.nick}` : ""}`
                : account.error}
          </p>
          <small>
            {account?.autoRenewal
              ? "临时令牌自动续期已开启"
              : "正在读取续期状态"}
            {account?.tokenRefreshedAt
              ? ` · 最近续期 ${new Date(account.tokenRefreshedAt).toLocaleString()}`
              : ""}
          </small>
          <button className="ghost" onClick={refresh} disabled={!account}>
            {account ? "检测并续期" : "检测中…"}
          </button>
        </div>
      </section>
      <section className="panel setting-card">
        <span className="ok-dot" />
        <div>
          <h2>Cron 定时任务</h2>
          <p>服务端密钥已配置，接口路径为 /api/jobs/run</p>
        </div>
      </section>
      <section className="panel setting-card">
        <span className={account?.email?.configured ? "ok-dot" : "bad-dot"} />
        <div>
          <h2>缺配置邮件提醒</h2>
          <p>
            {account?.email?.configured
              ? `已启用 · 收件人 ${account.email.recipient}`
              : `尚未配置 RESEND_API_KEY · 计划收件人 ${account?.email?.recipient || "bingsun2020@163.com"}`}
          </p>
          <small>同一订单只发送一次，补齐发货配置后下一轮会自动继续处理。</small>
        </div>
      </section>
      <section className="panel info-card">
        <h2>运行策略</h2>
        <ul>
          <li>临时令牌：过期后自动获取新令牌并重试</li>
          <li>长期登录：真正退出账号后才需重新采集 Cookie</li>
          <li>订单轮询：建议每 5 分钟触发</li>
          <li>敏感数据：长期 Cookie 仅保存在 Sites 加密环境变量</li>
        </ul>
      </section>
    </div>
  );
}
function ProductPanel({
  title,
  sub,
  products,
  action,
  productAction,
}: {
  title: string;
  sub: string;
  products: Product[];
  action?: React.ReactNode;
  productAction?: (product: Product) => React.ReactNode;
}) {
  return (
    <section className="panel queue">
      <div className="panel-title">
        <div>
          <h2>{title}</h2>
          <p>{sub}</p>
        </div>
        {action}
      </div>
      <div className="product-list">
        {products.length ? (
          <>
            {products.map((p) => (
              <article key={p.id}>
                <div className="thumb">
                  {image(p) ? (
                    <img
                      src={image(p)}
                      alt={`${p.title} 商品图`}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    "鱼"
                  )}
                </div>
                <div className="product-main">
                  <b>{p.title}</b>
                  <small>
                    ¥ {(p.priceCents / 100).toFixed(2)} ·{" "}
                    {p.xianyuItemId || `任务 #${p.id}`}
                  </small>
                  {p.deliveryContent && <em className="bound">已配置发货</em>}
                </div>
                <Status value={p.status} />
                {productAction?.(p)}
              </article>
            ))}
          </>
        ) : (
          <div className="empty">
            <span>＋</span>
            <b>还没有商品</b>
            <p>点击同步闲鱼商品或创建上架任务</p>
          </div>
        )}
      </div>
    </section>
  );
}
function imageUrls(p: Product) {
  try {
    const values = JSON.parse(p.imagesJson || "[]") as Array<
      string | ListingImage
    >;
    return values
      .map((value) => (typeof value === "string" ? value : value.url))
      .filter(Boolean);
  } catch {
    return [];
  }
}
function skuLines(p: Product) {
  try {
    const rows = JSON.parse(p.skuJson || "[]") as Array<{
      properties?: Array<{ name?: string; value?: string }>;
      priceCents?: number;
      quantity?: number;
    }>;
    return rows
      .map((row) => {
        const properties = (row.properties || [])
          .map((property) => `${property.name || ""}=${property.value || ""}`)
          .join(";");
        return `${properties}|${(Number(row.priceCents || 0) / 100).toFixed(2)}|${Number(row.quantity || 0)}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}
function propertyLines(p: Product) {
  try {
    const rows = JSON.parse(p.propertiesJson || "[]") as Array<{
      name?: string;
      value?: string;
    }>;
    return rows
      .map((row) => `${row.name || ""}=${row.value || ""}`)
      .join("\n");
  } catch {
    return "";
  }
}
function image(p: Product) {
  const source = imageUrls(p)[0] || "";
  return source
    ? `/api/xianyu/image?url=${encodeURIComponent(source)}`
    : "";
}
function message(e: unknown) {
  return e instanceof Error ? e.message : "操作失败";
}
function inventoryStatus(value: InventoryRow["status"]) {
  return { available: "可用", reserved: "已预留", used: "已使用" }[value];
}
function formatRunSummary(value: string) {
  try {
    const summary = JSON.parse(value) as Record<string, unknown>;
    const parts = [
      `扫描 ${Number(summary.pendingOrders || 0)} 单`,
      `发布 ${Number(summary.published || 0)} 件`,
      `发货 ${Number(summary.delivered || 0)} 单`,
      `待补配置 ${Number(summary.configurationAlerts || 0)} 单`,
      `邮件 ${Number(summary.emailsSent || 0)} 封`,
    ];
    if (Number(summary.failed || 0)) parts.push(`失败 ${summary.failed}`);
    return parts.join(" · ");
  } catch {
    return value;
  }
}
function subtitle(x: string) {
  return (
    {
      总览: "账号商品、库存与任务运行概况",
      商品上架: "同步并维护闲鱼现有商品，或创建新的上架任务",
      自动发货: "按商品配置固定内容、网盘链接或卡密库存",
      任务记录: "追踪定时发布、订单轮询和自动发货结果",
      系统设置: "检查账号连接和自动任务运行状态",
    }[x] || ""
  );
}
function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone: string;
}) {
  return (
    <article className={`stat ${tone}`}>
      <span className="stat-icon">
        {tone === "blue"
          ? "▦"
          : tone === "cyan"
            ? "↗"
            : tone === "violet"
              ? "◇"
              : "✓"}
      </span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <p>{hint}</p>
      </div>
    </article>
  );
}
function Status({ value }: { value: string }) {
  const map: Record<string, string> = {
    draft: "草稿",
    queued: "待发布",
    published: "在售",
    offline: "已下架",
    sold: "已售出",
    unknown: "其他状态",
    running: "执行中",
    success: "成功",
    partial: "部分完成",
    failed: "失败",
    pending: "待处理",
    message_sent: "消息已发送",
    needs_configuration: "待补发货配置",
    delivered: "已发货",
    refund: "退款中",
  };
  return <span className={`status ${value}`}>{map[value] || value}</span>;
}
