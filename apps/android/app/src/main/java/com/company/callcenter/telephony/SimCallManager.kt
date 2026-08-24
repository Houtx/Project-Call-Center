package com.company.callcenter.telephony

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.company.callcenter.BuildConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class AvailableSim(
    val slotIndex: Int,
    val displayName: String,
) {
    val slotLabel: String
        get() = "卡${slotIndex + 1}"
}

data class SimDialState(
    val mode: SimDialMode = SimDialMode.SIM_1,
    val availableSims: List<AvailableSim> = emptyList(),
    val systemManagedRouting: Boolean = false,
) {
    val canDial: Boolean
        get() = availableSims.isNotEmpty() || systemManagedRouting
}

enum class CallLaunchRoute {
    ROUTED_SIM,
    SYSTEM_MANAGED,
}

class SimCallManager(context: Context) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val subscriptionManager = appContext.getSystemService(SubscriptionManager::class.java)
    private val telephonyManager = appContext.getSystemService(TelephonyManager::class.java)
    private val telecomManager = appContext.getSystemService(TelecomManager::class.java)
    private val mutableState = MutableStateFlow(
        SimDialState(mode = SimDialMode.fromStorage(preferences.getString(MODE_KEY, null))),
    )

    val state: StateFlow<SimDialState> = mutableState.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        val routedSims = readRoutedSims()
        mutableState.value = mutableState.value.copy(
            availableSims = routedSims.map { it.sim },
            systemManagedRouting = routedSims.isEmpty() && canUseSystemManagedDialing(),
        )
    }

    fun setMode(mode: SimDialMode) {
        preferences.edit().putString(MODE_KEY, mode.storageValue).apply()
        mutableState.value = mutableState.value.copy(mode = mode)
    }

    fun requireAvailableSim() {
        refresh()
        check(mutableState.value.canDial) {
            "未检测到可用的 SIM 卡或系统电话服务"
        }
    }

    fun placeCall(phone: String): CallLaunchRoute {
        check(hasPermission(Manifest.permission.CALL_PHONE)) { "外呼权限未就绪" }
        val routedSims = readRoutedSims()
        val systemManagedRouting = routedSims.isEmpty() && canUseSystemManagedDialing()
        mutableState.value = mutableState.value.copy(
            availableSims = routedSims.map { it.sim },
            systemManagedRouting = systemManagedRouting,
        )

        val callUri = Uri.fromParts("tel", phone, null)
        if (routedSims.isEmpty()) {
            check(systemManagedRouting) { "未检测到可用的 SIM 卡或系统电话服务" }
            try {
                appContext.startActivity(
                    Intent(Intent.ACTION_CALL, callUri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            } catch (failure: SecurityException) {
                throw IllegalStateException("外呼权限已被撤销，请重新授权", failure)
            } catch (failure: ActivityNotFoundException) {
                throw IllegalStateException("系统电话服务不可用", failure)
            }
            return CallLaunchRoute.SYSTEM_MANAGED
        }

        val nextSlot = preferences.getInt(NEXT_ALTERNATE_SLOT_KEY, 0)
        val decision = SimRoutingPolicy.select(
            mode = mutableState.value.mode,
            availableSlotIndexes = routedSims.map { it.sim.slotIndex },
            nextAlternateSlotIndex = nextSlot,
        ) ?: error("未检测到可用于拨号的 SIM 卡")
        val routedSim = routedSims.first { it.sim.slotIndex == decision.slotIndex }
        val extras = Bundle().apply {
            putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, routedSim.phoneAccountHandle)
        }
        try {
            telecomManager.placeCall(callUri, extras)
        } catch (failure: SecurityException) {
            throw IllegalStateException("外呼权限已被撤销，请重新授权", failure)
        }

        if (mutableState.value.mode == SimDialMode.ALTERNATE && routedSims.size > 1) {
            preferences.edit()
                .putInt(NEXT_ALTERNATE_SLOT_KEY, decision.nextAlternateSlotIndex)
                .apply()
        }
        return CallLaunchRoute.ROUTED_SIM
    }

    private fun readRoutedSims(): List<RoutedSim> {
        if (!hasPermission(Manifest.permission.READ_PHONE_STATE)) {
            return emptyList()
        }
        return try {
            val callCapableAccounts = telecomManager.callCapablePhoneAccounts.toSet()
            val subscriptionsById = subscriptionManager.activeSubscriptionInfoList.orEmpty()
                .associateBy { it.subscriptionId }
            if (BuildConfig.DEBUG) {
                Log.d(
                    LOG_TAG,
                    "Discovering SIMs: accounts=${callCapableAccounts.map { it.id }}, " +
                        "subscriptions=${subscriptionsById.values.map { "${it.subscriptionId}:${it.simSlotIndex}" }}",
                )
            }
            callCapableAccounts
                .asSequence()
                .mapNotNull { accountHandle ->
                    val subscriptionId = SimRoutingPolicy.matchPhoneAccountSubscriptionId(
                        phoneAccountId = accountHandle.id,
                        activeSubscriptionIds = subscriptionsById.keys,
                    )
                        ?: runCatching { telephonyManager.getSubscriptionId(accountHandle) }.getOrNull()
                    val subscription = subscriptionsById[subscriptionId] ?: return@mapNotNull null
                    if (subscription.simSlotIndex !in SUPPORTED_SLOT_INDEXES) return@mapNotNull null
                    val displayName = subscription.displayName?.toString()?.trim()
                        .takeUnless { it.isNullOrEmpty() }
                        ?: subscription.carrierName?.toString()?.trim()
                            .takeUnless { it.isNullOrEmpty() }
                        ?: "SIM"
                    RoutedSim(
                        sim = AvailableSim(subscription.simSlotIndex, displayName),
                        phoneAccountHandle = accountHandle,
                    )
                }
                .distinctBy { it.sim.slotIndex }
                .sortedBy { it.sim.slotIndex }
                .take(2)
                .toList()
                .also {
                    if (BuildConfig.DEBUG) {
                        Log.d(LOG_TAG, "Available call slots: ${it.map { routed -> routed.sim.slotIndex }}")
                    }
                }
        } catch (failure: SecurityException) {
            Log.w(LOG_TAG, "SIM discovery permission failure: ${failure.javaClass.simpleName}")
            emptyList()
        } catch (failure: RuntimeException) {
            Log.w(LOG_TAG, "SIM discovery failure: ${failure.javaClass.simpleName}")
            emptyList()
        }
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(appContext, permission) == PackageManager.PERMISSION_GRANTED

    private fun canUseSystemManagedDialing(): Boolean {
        if (!hasPermission(Manifest.permission.CALL_PHONE)) return false
        val packageManager = appContext.packageManager
        val hasCallingFeature = packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY_CALLING) ||
            packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
        val callHandlerAvailable = Intent(Intent.ACTION_CALL, Uri.parse("tel:10086"))
            .resolveActivity(packageManager) != null
        return hasCallingFeature || callHandlerAvailable
    }

    private data class RoutedSim(
        val sim: AvailableSim,
        val phoneAccountHandle: PhoneAccountHandle,
    )

    private companion object {
        const val PREFERENCES_NAME = "sim_dial_settings"
        const val LOG_TAG = "CallCenterSim"
        const val MODE_KEY = "dial_mode"
        const val NEXT_ALTERNATE_SLOT_KEY = "next_alternate_slot"
        val SUPPORTED_SLOT_INDEXES = 0..1
    }
}
