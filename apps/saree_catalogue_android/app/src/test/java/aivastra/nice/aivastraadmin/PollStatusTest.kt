package tryme.nice.trymeadmin

import tryme.nice.trymeadmin.viewmodels.isTerminalGenerateStatus
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PollStatusTest {
    @Test
    fun `completed failed and cancelled are terminal`() {
        assertTrue(isTerminalGenerateStatus("COMPLETED"))
        assertTrue(isTerminalGenerateStatus("FAILED"))
        assertTrue(isTerminalGenerateStatus("CANCELLED"))
    }

    @Test
    fun `queued and processing are not terminal`() {
        assertFalse(isTerminalGenerateStatus("QUEUED"))
        assertFalse(isTerminalGenerateStatus("PROCESSING"))
        assertFalse(isTerminalGenerateStatus(""))
    }
}
