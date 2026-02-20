import type { ChangeEvent } from "react";

interface PhoneInputProps {
  value: string;
  onChange: (digits: string) => void;
}

export function PhoneInput({ value, onChange }: PhoneInputProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target.value;
    const digitsOnly = input.replace(/\D/g, "").slice(0, 11);
    onChange(digitsOnly);
  };

  const formatPhone = (digits: string): string => {
    const cleaned = digits.replace(/\D/g, "").slice(0, 11);
    const match = cleaned.match(
      /^(\d{1})(\d{0,3})(\d{0,3})(\d{0,2})(\d{0,2})$/,
    );

    if (!match) return "";

    let formatted = "+";
    if (match[1]) formatted += match[1];
    if (match[2]) formatted += ` (${match[2]}`;
    if (match[3]) formatted += `) ${match[3]}`;
    if (match[4]) formatted += `-${match[4]}`;
    if (match[5]) formatted += `-${match[5]}`;

    return formatted;
  };

  const MaskedPhone = formatPhone(value);

  return (
    <input
      type="tel"
      value={MaskedPhone}
      onChange={handleChange}
      placeholder="Номер телефона"
      className="input phone-input"
    />
  );
}
