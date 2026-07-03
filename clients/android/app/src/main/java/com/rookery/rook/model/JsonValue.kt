// Mirrors clients/RookKit/Sources/RookKit/Models/JSONValue.swift
//
// No new JSON tree type — kotlinx.serialization.json.JsonElement already covers the same
// null/bool/number/string/array/object shape, so these are thin convenience accessors
// matching JSONValue's subscript/stringValue/boolValue/numberValue.
package com.rookery.rook.model

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

operator fun JsonElement.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)

val JsonElement.stringValue: String?
    get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

val JsonElement.boolValue: Boolean?
    get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toBooleanStrictOrNull()

val JsonElement.numberValue: Double?
    get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull()
