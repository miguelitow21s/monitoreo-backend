# Ejemplos reales de request/response

## Iniciar turno (start)

**Request:**
POST /functions/v1/shifts/start
Authorization: Bearer <token>
{
  "restaurant_id": 1,
  "lat": -34.6037,
  "lng": -58.3816
}

**Response (éxito):**
{
  "success": true,
  "data": { "shift_id": 123 },
  "error": null,
  "request_id": "..."
}

**Response (error GPS):**
{
  "success": false,
  "data": null,
  "error": { "code": 409, "message": "GPS fuera de radio", "request_id": "..." },
  "request_id": "..."
}

## Subir evidencia

**Request:**
POST /functions/v1/evidence/upload
Authorization: Bearer <token>
{
  "shift_id": 123,
  "url": "https://...",
  "type": "inicio",
  "lat": -34.6037,
  "lng": -58.3816
}

**Response (éxito):**
{
  "success": true,
  "data": {},
  "error": null,
  "request_id": "..."
}

**Response (evidencia duplicada):**
{
  "success": false,
  "data": null,
  "error": { "code": 409, "message": "Evidencia duplicada", "request_id": "..." },
  "request_id": "..."
}
