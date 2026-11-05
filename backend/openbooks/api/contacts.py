"""Customers and vendors share one table and one set of endpoints."""
from flask import jsonify, request

from ..models import Bill, Contact, Expense, Invoice, TimeEntry, db, money
from ..util import ApiError, body, get_or_404, opt_str, required_str
from . import bp

KINDS = {"customers": "customer", "vendors": "vendor"}


def _kind(collection):
    if collection not in KINDS:
        raise ApiError("Not found", 404)
    return KINDS[collection]


def _with_balance(contact):
    d = contact.to_dict()
    docs = (
        Invoice.query.filter_by(customer_id=contact.id, kind="invoice")
        if contact.kind == "customer"
        else Bill.query.filter_by(vendor_id=contact.id)
    ).all()
    d["open_balance"] = money(sum(doc.balance_cents for doc in docs))
    d["overdue_balance"] = money(sum(doc.balance_cents for doc in docs if doc.display_status == "overdue"))
    return d


@bp.get("/<any(customers, vendors):collection>")
def list_contacts(collection):
    kind = _kind(collection)
    q = Contact.query.filter_by(kind=kind)
    if request.args.get("include_inactive") != "1":
        q = q.filter_by(active=True)
    search = (request.args.get("q") or "").strip()
    if search:
        like = f"%{search}%"
        q = q.filter(
            Contact.name.ilike(like) | Contact.company.ilike(like) | Contact.email.ilike(like)
        )
    return jsonify([_with_balance(c) for c in q.order_by(Contact.name).all()])


@bp.get("/<any(customers, vendors):collection>/<int:contact_id>")
def get_contact(collection, contact_id):
    kind = _kind(collection)
    contact = get_or_404(Contact, contact_id, kind.capitalize())
    if contact.kind != kind:
        raise ApiError(f"{kind.capitalize()} not found", 404)
    return jsonify(_with_balance(contact))


def _apply(contact, data):
    contact.name = required_str(data, "name")
    for field in ("company", "email", "phone", "address", "notes", "address_line1", "city", "region", "postal_code", "exemption_reason"):
        if field in data:
            setattr(contact, field, opt_str(data, field))
    if "country" in data:
        country = opt_str(data, "country").upper()
        if country and (len(country) != 2 or not country.isalpha()):
            raise ApiError("Country must be a 2-letter code such as US, GB, CA or AU")
        contact.country = country
    if "tax_exempt" in data:
        contact.tax_exempt = bool(data["tax_exempt"])
    if "default_tax_code_id" in data:
        from ..models import TaxCode

        code_id = data.get("default_tax_code_id") or None
        if code_id and db.session.get(TaxCode, code_id) is None:
            raise ApiError("Unknown tax code")
        contact.default_tax_code_id = code_id
    # keep the free-text address in sync with the structured fields
    if any(k in data for k in ("address_line1", "city", "region", "postal_code", "country")) and not data.get("address"):
        city_line = " ".join(p for p in (contact.city, contact.region, contact.postal_code) if p)
        contact.address = "\n".join(p for p in (contact.address_line1, city_line, contact.country) if p)
    if contact.email and "@" not in contact.email:
        raise ApiError("Enter a valid email address")
    if "active" in data:
        contact.active = bool(data["active"])


@bp.post("/<any(customers, vendors):collection>")
def create_contact(collection):
    contact = Contact(kind=_kind(collection))
    _apply(contact, body())
    db.session.add(contact)
    db.session.commit()
    return jsonify(_with_balance(contact)), 201


@bp.put("/<any(customers, vendors):collection>/<int:contact_id>")
def update_contact(collection, contact_id):
    kind = _kind(collection)
    contact = get_or_404(Contact, contact_id, kind.capitalize())
    if contact.kind != kind:
        raise ApiError(f"{kind.capitalize()} not found", 404)
    _apply(contact, body())
    db.session.commit()
    return jsonify(_with_balance(contact))


@bp.delete("/<any(customers, vendors):collection>/<int:contact_id>")
def delete_contact(collection, contact_id):
    kind = _kind(collection)
    contact = get_or_404(Contact, contact_id, kind.capitalize())
    if contact.kind != kind:
        raise ApiError(f"{kind.capitalize()} not found", 404)
    used = (
        Invoice.query.filter_by(customer_id=contact.id).first()
        or Bill.query.filter_by(vendor_id=contact.id).first()
        or Expense.query.filter_by(vendor_id=contact.id).first()
        or TimeEntry.query.filter_by(customer_id=contact.id).first()
    )
    if used:
        raise ApiError(f"This {kind} has transactions. Make them inactive instead of deleting.")
    db.session.delete(contact)
    db.session.commit()
    return jsonify({"ok": True})
