package tryme.nice.trymeadmin

import tryme.nice.trymeadmin.viewmodels.MerchantCatalogSareeStyle
import tryme.nice.trymeadmin.viewmodels.MerchantCatalogSareeStyleListResponse
import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SareeStyleTest {

    @Test
    fun `parse saree styles JSON response correctly`() {
        val json = """
            {
              "items": [
                {
                  "id": "550e8400-e29b-41d4-a716-446655440000",
                  "label": "Nivi",
                  "previewUrl": "https://example.com/nivi.jpg",
                  "sortOrder": 1,
                  "supportsTwoInput": true
                },
                {
                  "id": "550e8400-e29b-41d4-a716-446655440001",
                  "label": "Gujarati",
                  "previewUrl": "https://example.com/gujarati.jpg",
                  "sortOrder": 2,
                  "supportsTwoInput": false
                }
              ]
            }
        """.trimIndent()

        val mapper = ObjectMapper()
        val response = mapper.readValue(json, MerchantCatalogSareeStyleListResponse::class.java)

        assertEquals(2, response.items.size)

        val nivi = response.items[0]
        assertEquals("550e8400-e29b-41d4-a716-446655440000", nivi.id)
        assertEquals("Nivi", nivi.label)
        assertEquals("https://example.com/nivi.jpg", nivi.previewUrl)
        assertEquals(1, nivi.sortOrder)
        assertTrue(nivi.supportsTwoInput)

        val gujarati = response.items[1]
        assertFalse(gujarati.supportsTwoInput)
    }

    @Test
    fun `filter two input styles correctly`() {
        val style1 = MerchantCatalogSareeStyle(id = "1", label = "Nivi", supportsTwoInput = true)
        val style2 = MerchantCatalogSareeStyle(id = "2", label = "Bengali", supportsTwoInput = false)
        val style3 = MerchantCatalogSareeStyle(id = "3", label = "Seedha Pallu", supportsTwoInput = true)

        val styles = listOf(style1, style2, style3)
        val twoInputStyles = styles.filter { it.supportsTwoInput }

        assertEquals(2, twoInputStyles.size)
        assertEquals("Nivi", twoInputStyles[0].label)
        assertEquals("Seedha Pallu", twoInputStyles[1].label)
    }
}
