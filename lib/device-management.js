'use strict';

const { DeviceManagement } = require('@iobroker/dm-utils');
const { translate } = require('./i18n');

// Shown below an expanded device, live from its states.
const DETAILS = [
    [{ en: 'IP address', de: 'IP-Adresse' }, 'info.ip'],
    [{ en: 'Model', de: 'Modell' }, 'info.model'],
    [{ en: 'Serial number', de: 'Seriennummer' }, 'info.serial'],
    [{ en: 'Firmware', de: 'Firmware' }, 'info.firmware'],
    [{ en: 'Amplifier chip', de: 'Verstärker-Chip' }, 'info.mcuVersion'],
    [{ en: 'Input', de: 'Eingang' }, 'source'],
    [{ en: 'Volume', de: 'Lautstärke' }, 'volume'],
    [{ en: 'Maximum volume', de: 'Höchstlautstärke' }, 'maxVolume'],
];

const ICON =
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+CiAgPHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiNlM2U5ZWYiLz4KICA8cmVjdCB4PSIxNyIgeT0iOCIgd2lkdGg9IjMwIiBoZWlnaHQ9IjQ4IiByeD0iNSIgZmlsbD0iI2ZmZiIgc3Ryb2tlPSIjMGYxNDE5IiBzdHJva2Utd2lkdGg9IjMiLz4KICA8Y2lyY2xlIGN4PSIzMiIgY3k9IjE5IiByPSI0IiBmaWxsPSIjMGYxNDE5Ii8+CiAgPGNpcmNsZSBjeD0iMzIiIGN5PSIzOCIgcj0iMTAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzBmMTQxOSIgc3Ryb2tlLXdpZHRoPSIzIi8+CiAgPGNpcmNsZSBjeD0iMzIiIGN5PSIzOCIgcj0iMyIgZmlsbD0iIzBmMTQxOSIvPgo8L3N2Zz4K';

/**
 * Lists the amplifiers in the admin's device manager: connection status,
 * address, and details such as model, serial number and firmware.
 */
class ArylicDeviceManagement extends DeviceManagement {
    /**
     * @returns {import('@iobroker/dm-utils').InstanceDetails} instance information
     */
    getInstanceInfo() {
        return {
            ...super.getInstanceInfo(),
            identifierLabel: translate({ en: 'IP address', de: 'IP-Adresse' }),
        };
    }

    /**
     * @param {import('@iobroker/dm-utils').DeviceLoadContext<string>} context collects the devices
     */
    loadDevices(context) {
        const devices = [...this.adapter.devices.values()];
        context.setTotalDevices(devices.length);
        for (const device of devices) {
            context.addDevice({
                id: device.id,
                identifier: device.host,
                name: device.name,
                icon: ICON,
                manufacturer: 'Arylic',
                model: device.info.model,
                status: {
                    connection: {
                        stateId: `${this.adapter.namespace}.${device.id}.info.connected`,
                        mapping: { true: 'connected', false: 'disconnected' },
                    },
                },
                hasDetails: true,
                actions: [
                    {
                        id: 'refresh',
                        icon: 'refresh',
                        description: translate({ en: 'Read all values now', de: 'Alle Werte jetzt lesen' }),
                        handler: () => {
                            device.refresh();
                            return { refresh: 'none' };
                        },
                    },
                    {
                        id: 'web',
                        icon: 'web',
                        description: translate({ en: 'Open the web interface', de: 'Weboberfläche öffnen' }),
                        url: `http://${device.host}`,
                    },
                ],
            });
        }
    }

    /**
     * @param {string} id device id
     * @returns {import('@iobroker/dm-utils').DeviceDetails<string>} details shown below the device
     */
    getDeviceDetails(id) {
        const items = {};
        DETAILS.forEach(([label, stateId], i) => {
            items[`row${i}`] = {
                type: 'state',
                oid: `${id}.${stateId}`,
                label: translate(label),
                control: 'text',
                sm: 12,
            };
        });
        return { id, schema: { type: 'panel', items } };
    }
}

module.exports = { ArylicDeviceManagement };
