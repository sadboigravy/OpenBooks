from flask import jsonify, request

from ..models import Account, Bill, Contact, Employee, Invoice, Item, money
from . import bp

LINK = {"invoice": "/invoices", "estimate": "/estimates", "sales_receipt": "/sales-receipts"}
LABEL = {"invoice": "Invoice", "estimate": "Estimate", "sales_receipt": "Sales receipt"}


@bp.get("/search")
def search():
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify([])
    like = f"%{q}%"
    results = []
    for c in Contact.query.filter(Contact.name.ilike(like) | Contact.company.ilike(like) | Contact.email.ilike(like)).limit(6):
        results.append({"type": c.kind.capitalize(), "title": c.name, "subtitle": c.company or c.email, "link": f"/{c.kind}s/{c.id}"})
    for d in Invoice.query.join(Contact, Invoice.customer_id == Contact.id).filter(Invoice.number.ilike(like) | Contact.name.ilike(like)).order_by(Invoice.date.desc()).limit(8):
        results.append({"type": LABEL[d.kind], "title": f"{LABEL[d.kind]} {d.number}", "subtitle": f"{d.customer.name} · {money(d.total_cents):.2f}", "link": f"{LINK[d.kind]}/{d.id}"})
    for b in Bill.query.join(Contact, Bill.vendor_id == Contact.id).filter(Bill.number.ilike(like) | Contact.name.ilike(like)).order_by(Bill.date.desc()).limit(5):
        results.append({"type": "Bill", "title": f"Bill {b.number}".strip(), "subtitle": f"{b.vendor.name} · {money(b.total_cents):.2f}", "link": f"/bills/{b.id}"})
    for i in Item.query.filter(Item.name.ilike(like) | Item.sku.ilike(like)).limit(5):
        results.append({"type": "Product/service", "title": i.name, "subtitle": f"{money(i.price_cents):.2f}", "link": "/items"})
    for e in Employee.query.filter(Employee.name.ilike(like)).limit(5):
        results.append({"type": "Employee", "title": e.name, "subtitle": e.job_title, "link": f"/employees/{e.id}"})
    for a in Account.query.filter(Account.name.ilike(like) | Account.code.ilike(like)).limit(5):
        results.append({"type": "Account", "title": a.label, "subtitle": a.type.capitalize(), "link": f"/reports/general-ledger?account_id={a.id}"})
    return jsonify(results[:20])
