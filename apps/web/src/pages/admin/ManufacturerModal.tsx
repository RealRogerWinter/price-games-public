import { useState, useEffect, useCallback } from "react";
import type {
  AdminManufacturerWithContacts,
  AdminContact,
  AdminContactCreateRequest,
  AdminContactType,
  AdminConfidence,
} from "@price-game/shared";
import {
  getManufacturerContacts,
  addManufacturerContact,
  updateManufacturerContact as apiUpdateContact,
  deleteManufacturerContact as apiDeleteContact,
} from "../../api/adminClient";

interface ManufacturerModalProps {
  name: string;
  onClose: () => void;
}

/**
 * Modal that shows manufacturer contact information.
 * Allows viewing, adding, editing, and deleting contacts.
 *
 * @param name - Manufacturer name to look up.
 * @param onClose - Callback to close the modal.
 */
export default function ManufacturerModal({ name, onClose }: ManufacturerModalProps) {
  const [data, setData] = useState<AdminManufacturerWithContacts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Inline editing state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<Partial<AdminContact>>({});

  // Add contact form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<AdminContactCreateRequest>({
    contactType: "general",
    confidence: "medium",
    email: "",
  });
  const [addError, setAddError] = useState<string | null>(null);

  // Delete confirmation
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setNotFound(false);
      const result = await getManufacturerContacts(name);
      setData(result);
    } catch (err: unknown) {
      if (err instanceof Error && (err.message.includes("404") || err.message.includes("not found"))) {
        setNotFound(true);
      } else {
        setError(err instanceof Error ? err.message : "Failed to load contacts");
      }
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  async function handleAddContact() {
    if (!data) return;
    try {
      setAddError(null);
      const contact = await addManufacturerContact(data.manufacturer.id, addForm);
      setData({ ...data, contacts: [...data.contacts, contact] });
      setShowAddForm(false);
      setAddForm({ contactType: "general", confidence: "medium", email: "" });
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : "Failed to add contact");
    }
  }

  function startEdit(contact: AdminContact) {
    setEditingId(contact.id);
    setEditForm({ ...contact });
  }

  async function saveEdit() {
    if (!data || editingId === null) return;
    try {
      const updated = await apiUpdateContact(data.manufacturer.id, editingId, {
        contactType: editForm.contactType,
        email: editForm.email ?? undefined,
        phone: editForm.phone ?? undefined,
        confidence: editForm.confidence,
        notes: editForm.notes ?? undefined,
        contactPageUrl: editForm.contactPageUrl ?? undefined,
        sourceUrl: editForm.sourceUrl ?? undefined,
      });
      setData({
        ...data,
        contacts: data.contacts.map((c) => (c.id === editingId ? updated : c)),
      });
      setEditingId(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update contact");
    }
  }

  async function handleDelete(contactId: number) {
    if (!data) return;
    try {
      await apiDeleteContact(data.manufacturer.id, contactId);
      setData({ ...data, contacts: data.contacts.filter((c) => c.id !== contactId) });
      setConfirmDeleteId(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete contact");
    }
  }

  function confidenceClass(confidence: string) {
    if (confidence === "high") return "confidence-high";
    if (confidence === "medium") return "confidence-medium";
    return "confidence-low";
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick} data-testid="manufacturer-modal">
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} data-testid="modal-close">
          &times;
        </button>

        <h2 className="modal-title">{name}</h2>

        {loading && (
          <div className="admin-loading" style={{ minHeight: "auto", padding: "40px 0" }}>
            <span className="admin-loading-spinner" />
            Loading contacts...
          </div>
        )}

        {error && <div className="admin-error" style={{ maxWidth: "100%" }}>{error}</div>}

        {notFound && (
          <div className="modal-not-found" data-testid="manufacturer-not-found">
            No contact info found for this manufacturer.
          </div>
        )}

        {data && !loading && (
          <>
            <div className="modal-mfg-info" data-testid="manufacturer-info">
              {data.manufacturer.website && /^https?:\/\//i.test(data.manufacturer.website) && (
                <p>
                  <strong>Website:</strong>{" "}
                  <a href={data.manufacturer.website} target="_blank" rel="noopener noreferrer">
                    {data.manufacturer.website}
                  </a>
                </p>
              )}
              <p><strong>Products:</strong> {data.manufacturer.productCount}</p>
              <p><strong>Status:</strong> {data.manufacturer.searchStatus}</p>
            </div>

            {data.contacts.length === 0 && !showAddForm && (
              <p style={{ color: "#666", marginTop: 16 }} data-testid="no-contacts">No contacts on file.</p>
            )}

            {data.contacts.length > 0 && (
              <table className="admin-table modal-contacts-table" data-testid="contacts-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Confidence</th>
                    <th>Notes</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.contacts.map((contact) => (
                    <tr key={contact.id} data-testid={`contact-row-${contact.id}`}>
                      {editingId === contact.id ? (
                        <>
                          <td>
                            <select
                              value={editForm.contactType ?? ""}
                              onChange={(e) => setEditForm({ ...editForm, contactType: e.target.value as AdminContactType })}
                            >
                              {["media", "promotions", "pr", "partnerships", "general", "support"].map((t) => (
                                <option key={t} value={t}>{t}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              type="email"
                              value={editForm.email ?? ""}
                              onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                              placeholder="Email"
                            />
                          </td>
                          <td>
                            <input
                              value={editForm.phone ?? ""}
                              onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                              placeholder="Phone"
                            />
                          </td>
                          <td>
                            <select
                              value={editForm.confidence ?? "medium"}
                              onChange={(e) => setEditForm({ ...editForm, confidence: e.target.value as AdminConfidence })}
                            >
                              <option value="high">high</option>
                              <option value="medium">medium</option>
                              <option value="low">low</option>
                            </select>
                          </td>
                          <td>
                            <input
                              value={editForm.notes ?? ""}
                              onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                              placeholder="Notes"
                            />
                          </td>
                          <td>
                            <button onClick={saveEdit} data-testid="save-edit-btn">Save</button>
                            <button onClick={() => setEditingId(null)}>Cancel</button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td>{contact.contactType}</td>
                          <td>{contact.email || "—"}</td>
                          <td>{contact.phone || "—"}</td>
                          <td>
                            <span className={`confidence-badge ${confidenceClass(contact.confidence)}`}>
                              {contact.confidence === "low" && "⚠ "}
                              {contact.confidence}
                            </span>
                          </td>
                          <td>{contact.notes || "—"}</td>
                          <td>
                            <button onClick={() => startEdit(contact)} data-testid={`edit-contact-${contact.id}`}>Edit</button>
                            {confirmDeleteId === contact.id ? (
                              <>
                                <button onClick={() => handleDelete(contact.id)} data-testid={`confirm-delete-${contact.id}`}>
                                  Confirm
                                </button>
                                <button onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                              </>
                            ) : (
                              <button onClick={() => setConfirmDeleteId(contact.id)} data-testid={`delete-contact-${contact.id}`}>
                                Delete
                              </button>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {showAddForm ? (
              <div className="modal-add-form" data-testid="add-contact-form">
                <h3>Add Contact</h3>
                {addError && <div className="admin-error" style={{ maxWidth: "100%", marginBottom: 8 }}>{addError}</div>}
                <div className="modal-form-grid">
                  <label>
                    Type:
                    <select
                      value={addForm.contactType}
                      onChange={(e) => setAddForm({ ...addForm, contactType: e.target.value as AdminContactType })}
                    >
                      {["media", "promotions", "pr", "partnerships", "general", "support"].map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Email:
                    <input
                      type="email"
                      value={addForm.email ?? ""}
                      onChange={(e) => setAddForm({ ...addForm, email: e.target.value })}
                      placeholder="contact@example.com"
                    />
                  </label>
                  <label>
                    Phone:
                    <input
                      value={addForm.phone ?? ""}
                      onChange={(e) => setAddForm({ ...addForm, phone: e.target.value })}
                      placeholder="555-1234"
                    />
                  </label>
                  <label>
                    Confidence:
                    <select
                      value={addForm.confidence}
                      onChange={(e) => setAddForm({ ...addForm, confidence: e.target.value as AdminConfidence })}
                    >
                      <option value="high">high</option>
                      <option value="medium">medium</option>
                      <option value="low">low</option>
                    </select>
                  </label>
                  <label>
                    Notes:
                    <input
                      value={addForm.notes ?? ""}
                      onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
                      placeholder="Optional notes"
                    />
                  </label>
                </div>
                <div style={{ marginTop: 12 }}>
                  <button onClick={handleAddContact} data-testid="submit-add-contact">Add</button>
                  <button onClick={() => setShowAddForm(false)} style={{ marginLeft: 8 }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowAddForm(true)}
                className="admin-btn-primary"
                style={{ marginTop: 16 }}
                data-testid="show-add-contact"
              >
                Add Contact
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
