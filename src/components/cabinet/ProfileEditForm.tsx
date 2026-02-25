import React, { useState } from "react";
import { Modal } from "../UI/Modal";
import { apiUploadProfilePhoto, apiUpdateProfile } from "../../utils/apiClient";

interface ProfileEditFormProps {
  isOpen: boolean;
  onClose: () => void;
  initialData: {
    email: string | null;
    firstName: string;
    lastName: string;
    middleName: string;
    sex: string;
    photo: string | null;
  };
  onSaveSuccess: () => void;
  showVerifyLevel?: boolean;
  onVerifyLevel?: () => void;
}

export const ProfileEditForm: React.FC<ProfileEditFormProps> = ({
  isOpen, onClose, initialData, onSaveSuccess, showVerifyLevel = false, onVerifyLevel,
}) => {
  const [formData, setFormData] = useState({
    email: initialData.email || "",
    firstName: initialData.firstName || "",
    lastName: initialData.lastName || "",
    middleName: initialData.middleName || "",
    sex: initialData.sex || "U",
    photo: initialData.photo || "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const res = await apiUploadProfilePhoto(file);
    if (res.data) setFormData((prev) => ({ ...prev, photo: res.data as string }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await apiUpdateProfile({
        email: formData.email.trim() || null,
        firstName: formData.firstName.trim() || null,
        lastName: formData.lastName.trim() || null,
        middleName: formData.middleName.trim() || null,
        sex: formData.sex || null,
        photo: formData.photo || null,
      });
      if (res.status === 200) { onSaveSuccess(); onClose(); }
      else setError("Не удалось сохранить изменения");
    } catch {
      setError("Произошла ошибка при сохранении");
    } finally {
      setSaving(false);
    }
  };

  const handleVerifyLevel = () => {
    onClose();
    onVerifyLevel?.();
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Редактировать профиль">
      <form onSubmit={handleSubmit}>
        {error && <p style={{ color: "var(--red)", fontSize: 14, marginBottom: 12 }}>{error}</p>}

        <div className="form-avatar-group">
          {formData.photo
            ? <img src={formData.photo} alt="Фото" className="form-avatar" />
            : <div className="form-avatar-placeholder">{formData.firstName?.[0]}{formData.lastName?.[0]}</div>
          }
          <input type="file" id="photo-upload" accept="image/*" onChange={handlePhotoChange} className="img-form-input" />
          <label htmlFor="photo-upload" className="auth-link">Изменить фото</label>
        </div>

        <div className="form-group">
          <label className="form-label">Фамилия</label>
          <input className="form-input" type="text" name="lastName" value={formData.lastName} onChange={handleInputChange} />
        </div>
        <div className="form-group">
          <label className="form-label">Имя</label>
          <input className="form-input" type="text" name="firstName" value={formData.firstName} onChange={handleInputChange} />
        </div>
        <div className="form-group">
          <label className="form-label">Отчество</label>
          <input className="form-input" type="text" name="middleName" value={formData.middleName} onChange={handleInputChange} />
        </div>
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-input" type="email" name="email" value={formData.email} onChange={handleInputChange} />
        </div>
        <div className="form-group">
          <label className="form-label">Пол</label>
          <select className="form-input" name="sex" value={formData.sex} onChange={handleInputChange}>
            <option value="U">Не указан</option>
            <option value="M">Мужской</option>
            <option value="F">Женский</option>
          </select>
        </div>

        {showVerifyLevel && onVerifyLevel && (
          <div className="form-verify-level">
            <button
              type="button"
              className="onboarding-btn onboarding-btn--secondary"
              onClick={handleVerifyLevel}
              disabled={saving}
            >
              Верифицировать уровень
            </button>
          </div>
        )}

        <div className="form-actions" style={{ marginTop: 20 }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Отмена</button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? "Сохранение..." : "Сохранить"}
          </button>
        </div>
      </form>
    </Modal>
  );
};
