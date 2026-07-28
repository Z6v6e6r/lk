// Viva no longer exposes the former letter custom field. The numeric field is
// the transition mirror; CUP derives the letter grade from this canonical value.
const NUM_FIELD_ID = "eabfe27b-3f72-4496-9185-1a2ec6e6465e";

msg.payload = msg.levelNumeric === ""
  ? []
  : [{ fieldId: NUM_FIELD_ID, value: [msg.levelNumeric] }];
return msg;
